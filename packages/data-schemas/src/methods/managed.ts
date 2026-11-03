import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import type {
  ManagedTarget,
  ManagedTargetKind,
  ManagedStorageTarget,
  ManagedPublication,
  CanonicalConversationTarget,
  ManagedState,
} from '~/types/managed';
import {
  ALLOCATION_PREFIX,
  isManagedMessageId,
  isManagedConversationId,
  includeManagedAllocations,
} from '~/utils/managed';
import { tenantPartitionFilter } from '~/models/plugins/tenantIsolation';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';

export const managedTargetModels = {
  message: 'Message',
  conversation: 'Conversation',
  response: 'StoredResponse',
} as const;
const identityFields = {
  message: 'messageId',
  conversation: 'conversationId',
  response: 'responseId',
} as const;

export class ManagedAllocationUnavailableError extends Error {
  readonly code = 'durable_storage_unavailable';
  constructor() {
    super('Durable storage allocation was not acknowledged');
    this.name = 'ManagedAllocationUnavailableError';
  }
}

export function assertManagedTenant(tenantId: string | undefined): void {
  tenantPartitionFilter('managed allocation');
  const current = getTenantId();
  if (current === SYSTEM_TENANT_ID || (current || undefined) !== (tenantId || undefined))
    throw new TypeError('Managed target tenant does not match the active scope');
}

export function canonicalConversationFilter(
  mongoose: typeof import('mongoose'),
  target: CanonicalConversationTarget,
): Record<string, unknown> {
  assertManagedTenant(target.tenantId);
  if (!/^[a-f\d]{24}$/i.test(target.id) || !target.userId || !target.conversationId)
    throw new TypeError('Invalid canonical conversation target');
  return {
    _id: new mongoose.Types.ObjectId(target.id),
    user: target.userId,
    conversationId: target.conversationId,
    tenantId: target.tenantId || { $in: [null, ''] },
  };
}

/** One-shot allocation: never put this call inside a retry of the same physical insert. */
export async function allocateManagedTarget<Kind extends ManagedTargetKind>(
  mongoose: typeof import('mongoose'),
  kind: Kind,
  tenantId?: string,
): Promise<ManagedTarget<Kind>> {
  assertManagedTenant(tenantId);
  if (!Object.prototype.hasOwnProperty.call(managedTargetModels, kind))
    throw new TypeError('Invalid managed target kind');
  const db = mongoose.connection.db;
  if (!db) throw new Error('Managed allocation requires a connected database');
  const model = mongoose.model(managedTargetModels[kind]);
  const id = new mongoose.Types.ObjectId();
  const incarnation = randomUUID();
  const command = {
    // eslint-disable-next-line no-restricted-syntax -- collection name only; the command is the one-shot metadata allocator.
    insert: model.collection.name,
    documents: [
      {
        _id: id,
        [identityFields[kind]]: `${ALLOCATION_PREFIX}${id.toHexString()}`,
        ...(kind === 'response' ? { requestKey: `${ALLOCATION_PREFIX}${id.toHexString()}` } : {}),
        ...(tenantId ? { tenantId } : {}),
        _managed: { incarnation, phase: 'empty' },
        createdAt: new Date(),
      },
    ],
    ordered: true,
  };
  if (db.writeConcern?.w === 0) throw new ManagedAllocationUnavailableError();
  if (db.writeConcern) mongoose.mongo.WriteConcern.apply(command, db.writeConcern);
  // RunCommandOperation has no retry aspect. Unlike insertOne, it cannot replay this ID.
  const result = await db.command(command, { readPreference: 'primary' });
  if (
    result.ok !== 1 ||
    result.n !== 1 ||
    Object.prototype.hasOwnProperty.call(result, 'writeConcernError') ||
    (Object.prototype.hasOwnProperty.call(result, 'writeErrors') &&
      (!Array.isArray(result.writeErrors) || result.writeErrors.length !== 0))
  )
    throw new ManagedAllocationUnavailableError();
  return { kind, id: id.toHexString(), incarnation, ...(tenantId ? { tenantId } : {}) };
}

export function managedTargetFilter(
  mongoose: typeof import('mongoose'),
  target: ManagedStorageTarget,
): {
  _id: Types.ObjectId;
  '_managed.incarnation': string;
  tenantId: string | { $in: Array<null | string> };
} {
  assertManagedTenant(target.tenantId);
  return managedTargetPredicate(mongoose, target);
}

/** Validated physical identity only; the owning operation must authorize its scope. */
export function managedTargetPredicate(
  mongoose: typeof import('mongoose'),
  target: ManagedStorageTarget,
): {
  _id: Types.ObjectId;
  '_managed.incarnation': string;
  tenantId: string | { $in: Array<null | string> };
} {
  if (
    !Object.prototype.hasOwnProperty.call(managedTargetModels, target.kind) ||
    !/^[a-f\d]{24}$/i.test(target.id) ||
    !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(target.incarnation)
  )
    throw new TypeError('Invalid managed target identity');
  return {
    _id: new mongoose.Types.ObjectId(target.id),
    '_managed.incarnation': target.incarnation,
    tenantId: target.tenantId || { $in: [null, ''] },
  };
}

/** Only unclaimed allocations may be discarded without their parent's retirement proof. */
export async function discardManagedAllocation(
  mongoose: typeof import('mongoose'),
  target: ManagedStorageTarget,
): Promise<boolean> {
  const filter = managedTargetFilter(mongoose, target);
  const allocation = {
    ...filter,
    [identityFields[target.kind]]: `${ALLOCATION_PREFIX}${target.id.toLowerCase()}`,
    user: { $exists: false },
  };
  const collection = mongoose.model(managedTargetModels[target.kind]).collection;
  const sealed = await collection.updateOne(
    {
      ...allocation,
      '_managed.phase': { $in: ['empty', 'retired'] },
    },
    { $set: { '_managed.phase': 'retired' } },
  );
  if (!sealed.matchedCount) return false;
  await collection.deleteOne({ ...allocation, '_managed.phase': 'retired' });
  return true;
}

export interface ManagedAllocationPage {
  limit: number;
  after?: string;
  tenantId?: string;
}

/** Existing logical-ID indexes bound this scan to allocation rows, rather than all history. */
export async function listManagedAllocations<Kind extends ManagedTargetKind>(
  mongoose: typeof import('mongoose'),
  kind: Kind,
  page: ManagedAllocationPage,
  phases: ReadonlyArray<Exclude<ManagedState['phase'], 'published'>>,
): Promise<{
  allocations: Array<{ target: ManagedTarget<Kind>; state: ManagedState }>;
  next?: string;
}> {
  assertManagedTenant(page.tenantId);
  if (
    !Object.prototype.hasOwnProperty.call(managedTargetModels, kind) ||
    !Number.isSafeInteger(page.limit) ||
    page.limit < 1 ||
    page.limit >= Number.MAX_SAFE_INTEGER ||
    (page.after !== undefined && !/^[a-f\d]{24}$/i.test(page.after))
  )
    throw new TypeError('Invalid allocation metadata page');
  const field = identityFields[kind];
  const rows = await includeManagedAllocations(
    mongoose.model(managedTargetModels[kind]).find({
      [field]: {
        $gt: `${ALLOCATION_PREFIX}${page.after?.toLowerCase() ?? ''}`,
        $lt: `${ALLOCATION_PREFIX}\uffff`,
      },
      tenantId: page.tenantId || { $in: [null, ''] },
      user: { $exists: false },
      '_managed.phase': { $in: phases },
    }),
  )
    .read('primary')
    .select(`_id +_managed ${field}`)
    .sort({ [field]: 1 })
    .limit(page.limit + 1)
    .lean<Array<{ _id: Types.ObjectId; _managed: ManagedState }>>();
  return {
    allocations: rows.slice(0, page.limit).map((row) => ({
      target: {
        kind,
        id: row._id.toHexString(),
        incarnation: row._managed.incarnation,
        ...(page.tenantId ? { tenantId: page.tenantId } : {}),
      },
      state: row._managed,
    })),
    ...(rows.length > page.limit && { next: rows[page.limit - 1]._id.toHexString() }),
  };
}

export async function sweepManagedAllocations(
  mongoose: typeof import('mongoose'),
  kind: ManagedTargetKind,
  page: ManagedAllocationPage,
): Promise<{ deleted: number; next?: string }> {
  const listed = await listManagedAllocations(mongoose, kind, page, ['empty', 'retired']);
  let deleted = 0;
  for (const { target } of listed.allocations)
    if (await discardManagedAllocation(mongoose, target)) deleted++;
  return { deleted, ...(listed.next && { next: listed.next }) };
}

/** Parent retirement or loss of its immutable selection must be proved before calling this. */
export async function retireManagedAllocation(
  mongoose: typeof import('mongoose'),
  target: ManagedStorageTarget,
  parentId: string,
): Promise<boolean> {
  const filter = managedTargetFilter(mongoose, target);
  if (!/^[a-f\d]{24}$/i.test(parentId)) throw new TypeError('Invalid managed parent identity');
  const collection = mongoose.model(managedTargetModels[target.kind]).collection;
  const retired = await collection.updateOne(
    {
      ...filter,
      [identityFields[target.kind]]: `${ALLOCATION_PREFIX}${target.id.toLowerCase()}`,
      user: { $exists: false },
      $or: [
        { '_managed.phase': 'empty' },
        {
          '_managed.parentId': parentId,
          '_managed.phase': { $in: ['pinned', 'registering', 'registered', 'retired'] },
        },
      ],
    },
    { $set: { '_managed.phase': 'retired' } },
  );
  if (retired.matchedCount !== 1) return false;
  return discardManagedAllocation(mongoose, target);
}

/** Pinning transfers orphan cleanup ownership to one immutable parent selection. */
export async function pinManagedTarget(
  mongoose: typeof import('mongoose'),
  target: ManagedStorageTarget,
  parentId: string,
): Promise<boolean> {
  if (!/^[a-f\d]{24}$/i.test(parentId)) throw new TypeError('Invalid managed parent identity');
  const filter = managedTargetFilter(mongoose, target);
  // eslint-disable-next-line no-restricted-syntax -- payload-free phase CAS; tenant, physical ID and incarnation were validated above.
  const result = await mongoose.model(managedTargetModels[target.kind]).collection.updateOne(
    {
      ...filter,
      $or: [
        { '_managed.phase': 'empty' },
        { '_managed.phase': 'pinned', '_managed.parentId': parentId },
      ],
    },
    { $set: { '_managed.phase': 'pinned', '_managed.parentId': parentId } },
  );
  return result.matchedCount === 1;
}

/** Caller must first freeze the parent's selected -> registering CAS. Never replace after this. */
export async function beginManagedTargetRegistration(
  mongoose: typeof import('mongoose'),
  target: ManagedStorageTarget,
  parentId: string,
): Promise<boolean> {
  const filter = managedTargetFilter(mongoose, target);
  if (!/^[a-f\d]{24}$/i.test(parentId)) throw new TypeError('Invalid managed parent identity');
  // eslint-disable-next-line no-restricted-syntax -- payload-free phase CAS with explicit tenant, incarnation and parent identity.
  const result = await mongoose.model(managedTargetModels[target.kind]).collection.updateOne(
    {
      ...filter,
      '_managed.parentId': parentId,
      '_managed.phase': { $in: ['pinned', 'registering'] },
    },
    { $set: { '_managed.phase': 'registering' } },
  );
  return result.matchedCount === 1;
}

export function managedPublicationFilter(
  mongoose: typeof import('mongoose'),
  publication: ManagedPublication,
): Record<string, unknown> {
  const filter = managedTargetFilter(mongoose, publication.target);
  if (
    !/^[a-f\d]{24}$/i.test(publication.parentId) ||
    ![publication.receipt, publication.ownerKey, publication.conversationKey].every((value) =>
      /^[a-f\d]{64}$/.test(value),
    ) ||
    !(publication.target.kind === 'message'
      ? isManagedMessageId(publication.logicalId) &&
        /^resp_d_[a-f\d]{32}$/.test(publication.logicalId)
      : isManagedConversationId(publication.logicalId))
  )
    throw new TypeError('Invalid managed publication');
  return {
    ...filter,
    '_managed.parentId': publication.parentId,
    '_managed.receipt': publication.receipt,
    '_managed.logicalId': publication.logicalId,
    '_managed.ownerKey': publication.ownerKey,
    '_managed.conversationKey': publication.conversationKey,
  };
}

/** Only call after every required authority has acknowledged this exact target registration. */
export async function markManagedTargetRegistered(
  mongoose: typeof import('mongoose'),
  publication: ManagedPublication,
): Promise<boolean> {
  const exact = managedPublicationFilter(mongoose, publication);
  // eslint-disable-next-line no-restricted-syntax -- private payload stays in canonical writers; this exact-identity CAS only seals metadata.
  const result = await mongoose
    .model(managedTargetModels[publication.target.kind])
    .collection.updateOne(
      {
        ...managedTargetFilter(mongoose, publication.target),
        '_managed.parentId': publication.parentId,
        $or: [{ '_managed.phase': 'registering' }, { ...exact, '_managed.phase': 'registered' }],
      },
      {
        $set: {
          '_managed.phase': 'registered',
          '_managed.receipt': publication.receipt,
          '_managed.logicalId': publication.logicalId,
          '_managed.ownerKey': publication.ownerKey,
          '_managed.conversationKey': publication.conversationKey,
        },
      },
    );
  return result.matchedCount === 1;
}
