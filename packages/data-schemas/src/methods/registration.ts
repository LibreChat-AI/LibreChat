import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { ManagedRegistration, ManagedRegistrationIntent } from '~/types/managed';
import type { ResponseOwner } from '~/models/response';
import { managedTargetFilter, assertManagedTenant, managedTargetModels } from './managed';
import { initializeResponseScopes, responseScopeKeys } from './responseScope';
import { createResponseScopeModel } from '~/models/responseScope';
import { includeManagedAllocations } from '~/utils/managed';

interface SettlementTarget {
  _id: Types.ObjectId;
  user?: string;
  userId?: string;
  conversationId?: string;
  expiredAt?: Date | null;
  _managed: {
    incarnation: string;
    phase?: string;
    ownerKey?: string;
    conversationKey?: string;
  };
}

const settlementProjection =
  '_id user userId conversationId expiredAt _managed.incarnation _managed.phase _managed.ownerKey _managed.conversationKey';

function hasPublishedOwnership(
  target: SettlementTarget,
  kind: ManagedRegistration['target']['kind'],
  owner: ResponseOwner,
  conversationId: string | undefined,
  key: string,
  expiredAt?: Date,
): boolean {
  return (
    target._managed.phase === 'published' &&
    (kind === 'response' ? target.userId : target.user) === owner.userId &&
    (conversationId === undefined
      ? target._managed.ownerKey === key
      : target._managed.conversationKey === key && target.conversationId === conversationId) &&
    (!expiredAt || (target.expiredAt instanceof Date && target.expiredAt <= expiredAt))
  );
}

export type ManagedRegistrationResult =
  | { status: 'registered'; retentionEpoch: number; expiredAt?: Date }
  | { status: 'closed' | 'capacity' | 'conflict' | 'retry' };

function registrationScope(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistrationIntent,
): string {
  managedTargetFilter(mongoose, entry.target);
  if (
    !owner.userId ||
    (owner.tenantId || undefined) !== (entry.target.tenantId || undefined) ||
    (conversationId !== undefined && !conversationId) ||
    !/^[a-f\d]{64}$/.test(entry.key) ||
    // Include conservative array-key/element overhead, not just the value's encoding.
    mongoose.mongo.BSON.calculateObjectSize({ ...entry, retentionEpoch: Number.MAX_SAFE_INTEGER }) +
      16 >
      512
  )
    throw new TypeError('Invalid managed registration');
  return responseScopeKeys(owner, conversationId ?? '')[conversationId === undefined ? 0 : 1];
}

function sameRegistration(
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

/** Register before payload publication. Closure freezes this bounded discovery list. */
async function registerResponseTargetOnce(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistrationIntent,
  options: { maxPendingTargetsPerScope?: number } = {},
): Promise<ManagedRegistrationResult> {
  const key = registrationScope(mongoose, owner, conversationId, entry);
  const { maxPendingTargetsPerScope } = durableStorageConfigSchema.parse(options);
  await initializeResponseScopes(mongoose, [key]);
  const scopes = createResponseScopeModel(mongoose);
  // A bounded retry covers normal publisher/settler races without an unbounded busy loop.
  for (let attempt = 0; attempt < 2; attempt++) {
    const anchor = await scopes.findById(key).lean();
    if (!anchor || anchor.closed || (anchor.expiredAt && anchor.expiredAt <= new Date()))
      return { status: 'closed' };
    const retentionEpoch = anchor.retentionEpoch ?? 0;
    if (!Number.isSafeInteger(retentionEpoch) || retentionEpoch < 0)
      throw new Error('Managed retention epoch is inconsistent');
    const existing = anchor.pending?.find((candidate) => candidate.key === entry.key);
    if (existing)
      return sameRegistration(existing, entry)
        ? {
            status: 'registered',
            retentionEpoch,
            ...(anchor.expiredAt && { expiredAt: anchor.expiredAt }),
          }
        : { status: 'conflict' };
    const count = anchor.pendingCount ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || count !== (anchor.pending?.length ?? 0))
      throw new Error('Managed registration counter is inconsistent');
    if (count >= maxPendingTargetsPerScope) return { status: 'capacity' };
    const current = await scopes
      .findOneAndUpdate(
        {
          _id: key,
          closed: false,
          retentionEpoch: retentionEpoch === 0 ? { $in: [0, null] } : retentionEpoch,
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
          $push: { pending: { key: entry.key, target: entry.target, retentionEpoch } },
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
    // Do not catch an ambiguous command: recovery reads the same operation on the primary.
  }
  return { status: 'retry' };
}

/** Reclaim missing one-shot allocations before refusing new work at the bounded capacity. */
export async function registerResponseTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistrationIntent,
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
  await reconcileResponseTargets(mongoose, owner, conversationId);
  // One bounded retry: concurrent registrars may consume the reclaimed space first.
  return registerResponseTargetOnce(mongoose, owner, conversationId, entry, options);
}

/** Remove discovery metadata only after indexed canonical ownership is installed. */
export async function settleResponseTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistrationIntent,
): Promise<boolean> {
  return settleTarget(mongoose, owner, conversationId, entry, 'published');
}

/** A deleted one-shot allocation cannot return: canonical publication never upserts its ID. */
export async function settleAbsentResponseTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistrationIntent,
): Promise<boolean> {
  return settleTarget(mongoose, owner, conversationId, entry, 'absent');
}

/** Recover interrupted publishers and late registrars without depending on their parent worker. */
export async function reconcileResponseTargets(
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
  const settled: ManagedRegistration[] = [];
  for (const kind of ['message', 'conversation', 'response'] as const) {
    const candidates = entries.filter((entry) => entry.target.kind === kind);
    if (!candidates.length) continue;
    const model = mongoose.model(managedTargetModels[kind]);
    const present = await includeManagedAllocations(
      model.find({
        $or: candidates.map((entry) => managedTargetFilter(mongoose, entry.target)),
      }),
    )
      .select(settlementProjection)
      .read('primary')
      .lean<SettlementTarget[]>();
    const targets = new Map(present.map((row) => [`${row._id}:${row._managed.incarnation}`, row]));
    settled.push(
      ...candidates.filter((entry) => {
        const target = targets.get(`${entry.target.id.toLowerCase()}:${entry.target.incarnation}`);
        return (
          !target ||
          hasPublishedOwnership(target, kind, owner, conversationId, key, anchor.expiredAt)
        );
      }),
    );
  }
  if (!settled.length) return 0;
  // Each removal retains its own exact-entry/closure/retention CAS. Partial or lost replies are retryable.
  // eslint-disable-next-line no-restricted-syntax -- payload-free ResponseScope has no tenant field; each CAS uses the validated tenant/owner scope hash.
  const result = await scopes.bulkWrite(
    settled.map((entry) => ({
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
  entry: ManagedRegistrationIntent,
  proof: 'published' | 'absent',
): Promise<boolean> {
  const key = registrationScope(mongoose, owner, conversationId, entry);
  const scopes = createResponseScopeModel(mongoose);
  const anchor = await scopes.findById(key).lean();
  if (!anchor || anchor.closed || (anchor.expiredAt && anchor.expiredAt <= new Date()))
    return false;
  const existing = anchor.pending?.find((candidate) => candidate.key === entry.key);
  if (!existing || !sameRegistration(existing, entry)) return false;
  const observedRetentionEpoch = anchor.retentionEpoch ?? 0;
  const model = mongoose.model(managedTargetModels[entry.target.kind]);
  if (proof === 'absent') {
    // Ordinary queries hide unpublished allocations. Hidden is not absent.
    const present = await includeManagedAllocations(
      model.exists(managedTargetFilter(mongoose, entry.target)),
    ).read('primary');
    if (present) return false;
  } else {
    const target = await includeManagedAllocations(
      model.findOne(managedTargetFilter(mongoose, entry.target)),
    )
      .select(settlementProjection)
      .read('primary')
      .lean<SettlementTarget | null>();
    if (
      !target ||
      !hasPublishedOwnership(
        target,
        entry.target.kind,
        owner,
        conversationId,
        key,
        anchor.expiredAt,
      )
    )
      return false;
  }
  const result = await scopes.updateOne(settlementFilter(key, existing, observedRetentionEpoch), {
    $pull: { pending: { key: entry.key } },
    $inc: { pendingCount: -1 },
  });
  return result.matchedCount === 1;
}

/** Scope keys come from an owned root or its closed admission anchor, never request input. */
export async function reconcileErasedResponseTargets(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationKeys: readonly string[],
): Promise<number> {
  assertManagedTenant(owner.tenantId);
  const keys = [...new Set([responseScopeKeys(owner, '')[0], ...conversationKeys])];
  if (keys.some((key) => !/^[a-f\d]{64}$/.test(key)))
    throw new TypeError('Invalid Response cleanup scope');
  const scopes = createResponseScopeModel(mongoose);
  let count = 0;
  for (const key of keys) {
    const anchor = await scopes.findById(key).lean();
    if (!anchor?.pending?.length) continue;
    const absent: ManagedRegistration[] = [];
    for (const kind of ['message', 'conversation', 'response'] as const) {
      const entries = anchor.pending.filter((entry) => entry.target.kind === kind);
      if (!entries.length) continue;
      const model = mongoose.model(managedTargetModels[kind]);
      const rows = await includeManagedAllocations(
        model.find({
          $or: entries.map((entry) => {
            if ((entry.target.tenantId || undefined) !== (owner.tenantId || undefined))
              throw new Error('Response cleanup target tenant changed');
            return managedTargetFilter(mongoose, entry.target);
          }),
        }),
      )
        .select('_id +_managed')
        .read('primary')
        .lean<SettlementTarget[]>();
      const present = new Set(rows.map((row) => `${row._id}:${row._managed.incarnation}`));
      absent.push(
        ...entries.filter(
          (entry) => !present.has(`${entry.target.id.toLowerCase()}:${entry.target.incarnation}`),
        ),
      );
    }
    if (!absent.length) continue;
    // eslint-disable-next-line no-restricted-syntax -- metadata-only exact-entry CAS on validated owned scope hashes, with positive physical absence proof.
    const result = await scopes.bulkWrite(
      absent.map((entry) => ({
        updateOne: {
          filter: {
            ...settlementFilter(key, entry, anchor.retentionEpoch ?? 0),
            closed: anchor.closed,
            $or: [{ expiredAt: anchor.expiredAt ?? null }],
          },
          update: { $pull: { pending: { key: entry.key } }, $inc: { pendingCount: -1 } },
        },
      })),
      { ordered: false },
    );
    count += result.matchedCount;
  }
  return count;
}
