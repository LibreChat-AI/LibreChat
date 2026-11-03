import type { UpdateQuery } from 'mongoose';
import type { ResponseOwner, StoredResponseRecord, ResponseReference } from '~/models/response';
import type { ManagedState } from '~/types/managed';
import { responseOwnerFilter, responseScopeKeys, closeResponseScopes } from './responseScope';
import { tenantStorage, getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { ALLOCATION_PREFIX, includeManagedAllocations } from '~/utils/managed';
import { eraseChannelFeedbackForOwner } from './channelFeedbackErasure';
import { managedTargetFilter, managedTargetModels } from './managed';
import { createResponseScopeModel } from '~/models/responseScope';
import { reconcileErasedResponseTargets } from './registration';
import { createStoredResponseModel } from '~/models/response';
import { responseRootFilter } from './responseRoot';

const ERASURE_BATCH_SIZE = 100;

/** Deletion is admitted and private data is hidden; physical cleanup still owns this root. */
export class ResponseErasurePendingError extends Error {
  readonly code = 'response_erasure_pending';
  constructor() {
    super('Response erasure is pending provider, checkpoint or canonical storage cleanup');
    this.name = 'ResponseErasurePendingError';
  }
}

/** Retirement invalidates paused selection CASes before any physical target is removed. */
export function retiredResponseUpdate(now: Date = new Date()): UpdateQuery<StoredResponseRecord> {
  return {
    $set: { '_managed.phase': 'retired' },
    $min: { retiredAt: now },
    $inc: { revision: 1 },
    $unset: {
      requestJSON: 1,
      responseJSON: 1,
      review: 1,
      resume: 1,
      preparedTerminal: 1,
      pendingTerminal: 1,
    },
  };
}

/** One retained root bounds its immutable target map; target commands are batched by fixed kind. */
export async function finishResponseErasure(
  mongoose: typeof import('mongoose'),
  reference: ResponseReference,
): Promise<boolean> {
  const records = createStoredResponseModel(mongoose);
  const physical = responseRootFilter(mongoose, reference);
  const root = await includeManagedAllocations(
    records.findOne({ ...physical, '_managed.phase': 'retired' }),
  )
    .select('canonicalTargets generationCreatedAt +providerExecution +checkpoint')
    .lean();
  if (!root) return !(await includeManagedAllocations(records.exists(physical)).read('primary'));
  const selections = root.canonicalTargets ?? [];
  for (const kind of ['message', 'conversation'] as const) {
    const targets = selections
      .filter((entry) => entry.target.kind === kind)
      .map(({ target }) => {
        if ((target.tenantId || undefined) !== (reference.tenantId || undefined))
          throw new Error('Response cleanup target tenant changed');
        return managedTargetFilter(mongoose, target);
      });
    if (!targets.length) continue;
    const model = mongoose.model(managedTargetModels[kind]);
    for (let offset = 0; offset < targets.length; offset += ERASURE_BATCH_SIZE) {
      const page = targets.slice(offset, offset + ERASURE_BATCH_SIZE);
      // A selected allocation may not yet be pinned. Its retirement wins against that
      // late pin; published targets additionally retain this exact parent and owner.
      const authorized = {
        $and: [
          { $or: page },
          { $or: [{ '_managed.phase': 'empty' }, { '_managed.parentId': reference.target.id }] },
          { $or: [{ user: reference.userId }, { user: { $exists: false } }] },
        ],
      };
      await model.updateMany(
        authorized,
        { $set: { '_managed.phase': 'retired', '_managed.parentId': reference.target.id } },
        { upsert: false },
      );
      await model.deleteMany({ ...authorized, '_managed.phase': 'retired' });
      if (await includeManagedAllocations(model.exists({ $or: page })).read('primary'))
        return false;
    }
  }
  const deleted = await records.deleteOne({
    ...physical,
    '_managed.phase': 'retired',
    canonicalTargets: root.canonicalTargets ?? { $exists: false },
    $or: [
      { generationCreatedAt: { $exists: false } },
      {
        'providerExecution.drained': true,
        $or: [
          { checkpoint: { $exists: false } },
          { 'checkpoint.state': 'settled', 'checkpoint.erased': true },
        ],
      },
    ],
  });
  return deleted.deletedCount === 1;
}

export async function eraseResponseRecords(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds?: readonly string[],
): Promise<void> {
  const current = getTenantId();
  if (
    !owner.userId ||
    owner.tenantId === SYSTEM_TENANT_ID ||
    (current !== SYSTEM_TENANT_ID && (current || undefined) !== (owner.tenantId || undefined))
  )
    throw new TypeError('Response cleanup tenant does not match the active scope');
  if (conversationIds?.length === 0) return;
  await tenantStorage.run({ tenantId: owner.tenantId || undefined }, () =>
    eraseOwnedResponses(mongoose, owner, conversationIds),
  );
}

async function eraseOwnedResponses(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds?: readonly string[],
): Promise<void> {
  const scopes = createResponseScopeModel(mongoose);
  const records = createStoredResponseModel(mongoose);
  const ownerKey = responseScopeKeys(owner, '')[0];
  const ownerAnchor = await scopes.findById(ownerKey).select('closed expiredAt').lean();
  const ownerClosed =
    ownerAnchor?.closed || (ownerAnchor?.expiredAt && ownerAnchor.expiredAt <= new Date());
  const keys =
    !conversationIds || ownerClosed
      ? [ownerKey]
      : conversationIds.map((id) => responseScopeKeys(owner, id)[1]);
  const admitted = await scopes.countDocuments({
    _id: { $in: keys },
    $or: [{ closed: true }, { expiredAt: { $lte: new Date() } }],
  });
  if (admitted !== new Set(keys).size)
    throw new Error('Response erasure requires closed admission');
  await eraseChannelFeedbackForOwner(mongoose, owner, conversationIds);
  const relatedScopes = new Set(keys.filter((key) => key !== ownerKey));
  for (const key of keys) {
    // One authority has a configured bounded pending list; do not load all owners' lists.
    const anchor = await scopes.findById(key).select('closed expiredAt pending').lean();
    if (!anchor || (!anchor.closed && !(anchor.expiredAt && anchor.expiredAt <= new Date())))
      throw new Error('Response erasure requires closed admission');
    const roots = (anchor.pending ?? []).filter((entry) => entry.target.kind === 'response');
    await tenantStorage.run({ tenantId: owner.tenantId || undefined }, async () => {
      const targets = roots.map(({ target }) => {
        if ((target.tenantId || undefined) !== (owner.tenantId || undefined))
          throw new Error('Response cleanup target tenant changed');
        return {
          ...managedTargetFilter(mongoose, target),
          responseId: `${ALLOCATION_PREFIX}${target.id.toLowerCase()}`,
          userId: { $exists: false },
        };
      });
      if (targets.length) {
        const metadata = await includeManagedAllocations(records.find({ $or: targets }))
          .select('+_managed')
          .read('primary')
          .lean<Array<{ _managed?: ManagedState }>>();
        for (const root of metadata) {
          const descriptor = root._managed;
          if (descriptor?.ownerKey && descriptor.ownerKey !== ownerKey)
            throw new Error('Response cleanup root owner changed');
          const conversationKey = descriptor?.conversationKey;
          if (!conversationKey) continue;
          if (
            !/^[a-f\d]{64}$/.test(conversationKey) ||
            (!ownerClosed && !keys.includes(conversationKey))
          )
            throw new Error('Response cleanup conversation scope changed');
          relatedScopes.add(conversationKey);
          if (ownerClosed)
            await scopes.updateOne(
              { _id: conversationKey },
              { $set: { closed: true }, $inc: { revision: 1 } },
              { upsert: true },
            );
        }
      }
      // Seal before deleting. A paused payload publisher must lose its registered-phase CAS.
      if (targets.length)
        await records.updateMany(
          {
            $or: targets,
            '_managed.phase': { $in: ['empty', 'pinned', 'registering', 'registered', 'retired'] },
          },
          { $set: { '_managed.phase': 'retired' } },
          { upsert: false },
        );
      if (targets.length) await records.deleteMany({ $or: targets, '_managed.phase': 'retired' });
      for (const kind of ['message', 'conversation'] as const) {
        const entries = (anchor.pending ?? []).filter((entry) => entry.target.kind === kind);
        if (!entries.length) continue;
        const child = mongoose.model(managedTargetModels[kind]);
        const exact = entries.map(({ target }) => {
          if ((target.tenantId || undefined) !== (owner.tenantId || undefined))
            throw new Error('Response cleanup target tenant changed');
          return managedTargetFilter(mongoose, target);
        });
        const authorized = {
          $and: [
            { $or: exact },
            { $or: [{ user: owner.userId }, { user: { $exists: false } }] },
            { '_managed.ownerKey': { $in: [ownerKey, null] } },
            ...(conversationIds
              ? [
                  {
                    $or: [
                      { conversationId: { $in: conversationIds } },
                      { user: { $exists: false } },
                    ],
                  },
                ]
              : []),
          ],
        };
        await child.updateMany(
          authorized,
          { $set: { '_managed.phase': 'retired' } },
          { upsert: false },
        );
        await child.deleteMany({ ...authorized, '_managed.phase': 'retired' });
      }
    });
  }
  const filter = {
    ...responseOwnerFilter(owner),
    ...(conversationIds ? { conversationId: { $in: conversationIds } } : {}),
    '_managed.phase': { $in: ['published', 'retired'] },
  };
  let after: import('mongoose').Types.ObjectId | undefined;
  let pending = false;
  for (;;) {
    const page = await includeManagedAllocations(
      records.find({ ...filter, ...(after ? { _id: { $gt: after } } : {}) }),
    )
      .select('_id storageTarget responseId conversationId')
      .sort({ _id: 1 })
      .limit(ERASURE_BATCH_SIZE)
      .lean();
    if (!page.length) break;
    if (ownerClosed)
      await closeResponseScopes(
        mongoose,
        owner,
        page.map((root) => root.conversationId),
      );
    await records.updateMany(
      { ...filter, _id: { $in: page.map((root) => root._id) } },
      retiredResponseUpdate(),
      { upsert: false },
    );
    for (const root of page) {
      if (!root.storageTarget) throw new Error('Response cleanup root identity is unavailable');
      if (
        !(await finishResponseErasure(mongoose, {
          ...owner,
          responseId: root.responseId,
          target: root.storageTarget,
        }))
      )
        pending = true;
    }
    await reconcileErasedResponseTargets(mongoose, owner, [
      ...new Set(page.map((root) => responseScopeKeys(owner, root.conversationId)[1])),
    ]);
    after = page[page.length - 1]._id;
  }
  await reconcileErasedResponseTargets(mongoose, owner, [...relatedScopes]);
  if (pending || (await includeManagedAllocations(records.exists(filter)).read('primary')))
    throw new ResponseErasurePendingError();
  const completionScopes = conversationIds
    ? conversationIds.map((id) => responseScopeKeys(owner, id)[1])
    : [ownerKey];
  for (const key of completionScopes) {
    const remaining = await scopes.findById(key).select('pendingCount pending').lean();
    if (remaining?.pendingCount || remaining?.pending?.length)
      throw new ResponseErasurePendingError();
  }
}
