import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { ManagedRegistration, ManagedRegistrationIntent } from '~/types/managed';
import type { ResponseOwner } from '~/models/response';
import {
  assertManagedRegistration,
  sameManagedRegistration,
  managedRegistryCount,
  managedRegistryEpoch,
  managedRegistryAdmissionFilter,
  managedRegistryEntryFilter,
} from './registry';
import {
  managedTargetFilter,
  managedTargetPredicate,
  assertManagedTenant,
  managedTargetModels,
} from './managed';
import {
  initializeResponseScopes,
  responseScopeKeys,
  assertResponseErasureOwner,
} from './responseScope';
import { createResponseScopeModel } from '~/models/responseScope';
import { includeManagedAllocations } from '~/utils/managed';
import { CHANNEL_PRIVATE_FIELDS } from '~/models/channel';
import { MANAGED_TARGET_KINDS } from '~/types/managed';

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
    scopeKeys?: string[];
    expiredAt?: Date;
  };
}

const settlementProjection =
  '_id user userId conversationId expiredAt _managed.incarnation _managed.phase _managed.ownerKey _managed.conversationKey _managed.scopeKeys _managed.expiredAt';

function hasPublishedOwnership(
  target: SettlementTarget,
  kind: ManagedRegistration['target']['kind'],
  owner: ResponseOwner,
  conversationId: string | undefined,
  key: string,
  expiredAt?: Date,
): boolean {
  const channel = kind.startsWith('channel');
  const owned = channel
    ? target._managed.scopeKeys?.includes(key) === true
    : (kind === 'response' ? target.userId : target.user) === owner.userId &&
      (conversationId === undefined
        ? target._managed.ownerKey === key
        : target._managed.conversationKey === key && target.conversationId === conversationId);
  const deadline = channel ? target._managed.expiredAt : target.expiredAt;
  return (
    target._managed.phase === 'published' &&
    owned &&
    (!expiredAt || (deadline instanceof Date && deadline <= expiredAt))
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
  access: 'publication' | 'cleanup' = 'publication',
): string {
  assertManagedRegistration(mongoose, entry, access);
  if (
    !owner.userId ||
    (owner.tenantId || undefined) !== (entry.target.tenantId || undefined) ||
    (conversationId !== undefined && !conversationId)
  )
    throw new TypeError('Invalid managed registration');
  return responseScopeKeys(owner, conversationId ?? '')[conversationId === undefined ? 0 : 1];
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
    const retentionEpoch = managedRegistryEpoch(anchor);
    const count = managedRegistryCount(anchor);
    const existing = anchor.pending?.find((candidate) => candidate.key === entry.key);
    if (existing)
      return sameManagedRegistration(existing, entry)
        ? {
            status: 'registered',
            retentionEpoch,
            ...(anchor.expiredAt && { expiredAt: anchor.expiredAt }),
          }
        : { status: 'conflict' };
    if (count >= maxPendingTargetsPerScope) return { status: 'capacity' };
    const current = await scopes
      .findOneAndUpdate(
        {
          _id: key,
          closed: false,
          ...managedRegistryAdmissionFilter(entry.key, maxPendingTargetsPerScope, retentionEpoch),
          $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
        },
        {
          $push: { pending: { key: entry.key, target: entry.target, retentionEpoch } },
          $inc: { pendingCount: 1, revision: 1 },
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

/** A deleting channel may retain coordination metadata after its creator's secrets are gone. */
export async function settleRedactedChannelTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  entry: ManagedRegistrationIntent,
): Promise<boolean> {
  if (entry.target.kind !== 'channel') throw new TypeError('Invalid channel credential target');
  return settleTarget(mongoose, owner, undefined, entry, 'redacted-channel');
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
  for (const kind of MANAGED_TARGET_KINDS) {
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
        update: { $pull: { pending: { key: entry.key } }, $inc: { pendingCount: -1, revision: 1 } },
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
    ...managedRegistryEntryFilter(entry, retentionEpoch),
    $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
  };
}

/** Physical absence cannot be undone by a compliant writer, even after scope closure. */
function absenceSettlementFilter(
  key: string,
  entry: ManagedRegistration,
  anchor: { retentionEpoch?: number; closed: boolean; expiredAt?: Date },
) {
  return {
    ...settlementFilter(key, entry, anchor.retentionEpoch ?? 0),
    closed: anchor.closed,
    $or: [{ expiredAt: anchor.expiredAt ?? null }],
  };
}

async function settleTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistrationIntent,
  proof: 'published' | 'absent' | 'redacted-channel',
): Promise<boolean> {
  const key = registrationScope(
    mongoose,
    owner,
    conversationId,
    entry,
    proof === 'published' ? 'publication' : 'cleanup',
  );
  const scopes = createResponseScopeModel(mongoose);
  const anchor = await scopes.findById(key).lean();
  if (
    !anchor ||
    (proof === 'published' &&
      (anchor.closed || (anchor.expiredAt && anchor.expiredAt <= new Date())))
  )
    return false;
  if (proof === 'redacted-channel' && !anchor.closed) return false;
  const existing = anchor.pending?.find((candidate) => candidate.key === entry.key);
  if (!existing || !sameManagedRegistration(existing, entry)) return false;
  const observedRetentionEpoch = anchor.retentionEpoch ?? 0;
  const model = mongoose.model(managedTargetModels[entry.target.kind]);
  if (proof === 'absent') {
    // Ordinary queries hide unpublished allocations. Hidden is not absent.
    const present = await includeManagedAllocations(
      model.exists(managedTargetPredicate(mongoose, entry.target)),
    ).read('primary');
    if (present) return false;
  } else if (proof === 'redacted-channel') {
    if (
      !(await includeManagedAllocations(
        model.exists({
          ...managedTargetPredicate(mongoose, entry.target),
          createdBy: owner.userId,
          status: 'deleting',
          '_managed.phase': 'published',
          '_managed.scopeKeys': key,
          ...Object.fromEntries(CHANNEL_PRIVATE_FIELDS.map((field) => [field, { $exists: false }])),
        }),
      ).read('primary'))
    )
      return false;
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
  const filter =
    proof === 'published'
      ? settlementFilter(key, existing, observedRetentionEpoch)
      : absenceSettlementFilter(key, existing, anchor);
  const result = await scopes.updateOne(filter, {
    $pull: { pending: { key: entry.key } },
    $inc: { pendingCount: -1, revision: 1 },
  });
  return result.matchedCount === 1;
}

/** Scope keys come from an owned root or its closed admission anchor, never request input. */
export async function reconcileErasedResponseTargets(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationKeys: readonly string[],
): Promise<number> {
  assertResponseErasureOwner(owner);
  const keys = [...new Set([responseScopeKeys(owner, '')[0], ...conversationKeys])];
  if (keys.some((key) => !/^[a-f\d]{64}$/.test(key)))
    throw new TypeError('Invalid Response cleanup scope');
  const scopes = createResponseScopeModel(mongoose);
  let count = 0;
  const pendingScopes = scopes
    .find({ _id: { $in: keys }, 'pending.0': { $exists: true } })
    .lean()
    .cursor({ batchSize: 1 });
  for await (const anchor of pendingScopes) {
    const key = anchor._id;
    const absent: ManagedRegistration[] = [];
    // Absence proof is shared across domains; their erasers still own retirement/drain.
    for (const kind of MANAGED_TARGET_KINDS) {
      const entries = anchor.pending!.filter((entry) => entry.target.kind === kind);
      if (!entries.length) continue;
      const model = mongoose.model(managedTargetModels[kind]);
      const rows = await includeManagedAllocations(
        model.find({
          $or: entries.map((entry) => {
            if ((entry.target.tenantId || undefined) !== (owner.tenantId || undefined))
              throw new Error('Response cleanup target tenant changed');
            return managedTargetPredicate(mongoose, entry.target);
          }),
        }),
      )
        .select({ _id: 1, _managed: 1 })
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
          filter: absenceSettlementFilter(key, entry, anchor),
          update: {
            $pull: { pending: { key: entry.key } },
            $inc: { pendingCount: -1, revision: 1 },
          },
        },
      })),
      { ordered: false },
    );
    count += result.matchedCount;
  }
  return count;
}
