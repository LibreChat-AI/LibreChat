import type { UpdateQuery } from 'mongoose';
import type {
  ResponseOwner,
  StoredResponseRecord,
  ResponseReference,
  ResponseReviewCheckpoint,
  ResponseResumeIntent,
} from '~/models/response';
import type { ManagedState, ManagedRegistration } from '~/types/managed';
import {
  responseOwnerFilter,
  responseScopeKeys,
  closeResponseScopes,
  closeResponseScopeKeys,
  assertResponseErasureOwner,
} from './responseScope';
import { tenantStorage, SYSTEM_TENANT_ID, runAsSystem } from '~/config/tenantContext';
import { ALLOCATION_PREFIX, includeManagedAllocations } from '~/utils/managed';
import { eraseChannelFeedbackForOwner } from './channelFeedbackErasure';
import { managedTargetPredicate, managedTargetModels } from './managed';
import { createResponseScopeModel } from '~/models/responseScope';
import { reconcileErasedResponseTargets } from './registration';
import { createStoredResponseModel } from '~/models/response';
import { responseRootCleanupFilter } from './responseRoot';

const ERASURE_BATCH_SIZE = 100;

/** Deletion is admitted and private data is hidden; physical cleanup still owns this root. */
export class ResponseErasurePendingError extends Error {
  readonly code = 'response_erasure_pending';
  constructor() {
    super('Response erasure is pending provider, checkpoint or canonical storage cleanup');
    this.name = 'ResponseErasurePendingError';
  }
}

/** Generic checkpoint cleanup cannot supersede the retained Response cleanup owner.
 * Read physical metadata so expired, retired and prepublication roots remain visible. */
export function createResponseCheckpointCleanupGuard(
  mongoose: typeof import('mongoose'),
): (owner: ResponseOwner, conversationIds?: readonly string[]) => Promise<boolean> {
  return async (owner, conversationIds) => {
    if (!owner.userId) throw new TypeError('Checkpoint cleanup requires an owner');
    const records = createStoredResponseModel(mongoose);
    const owners = owner.tenantId ? [owner, { userId: owner.userId }] : [owner];
    const ids = conversationIds == null ? undefined : [...new Set(conversationIds)];
    if (ids?.length === 0) return false;
    for (let offset = 0; offset < (ids?.length ?? 1); offset += ERASURE_BATCH_SIZE) {
      const page = ids?.slice(offset, offset + ERASURE_BATCH_SIZE);
      const clauses = owners.flatMap((partition) => {
        const ownerKey = responseScopeKeys(partition, '')[0];
        return [
          { ...responseOwnerFilter(partition), ...(page && { conversationId: { $in: page } }) },
          {
            '_managed.ownerKey': ownerKey,
            ...(page && {
              '_managed.conversationKey': {
                $in: page.map((id) => responseScopeKeys(partition, id)[1]),
              },
            }),
          },
        ];
      });
      if (
        await runAsSystem(
          async () =>
            await includeManagedAllocations(records.exists({ $or: clauses })).read('primary'),
        )
      )
        return true;
    }
    return false;
  };
}

// Every new review/resume field must explicitly choose erasure or bounded cleanup retention.
const reviewErasure: Record<keyof ResponseReviewCheckpoint, boolean> = {
  actionId: false,
  providerExecutionId: false,
  expiresAt: true,
  partialResponseJSON: true,
  visibleOutputTokens: true,
  pendingActionJSON: true,
  checkpointConfigJSON: true,
  checkpointId: true,
  checkpointNs: true,
};
const resumeErasure: Record<keyof ResponseResumeIntent, boolean> = {
  intentId: false,
  actionId: false,
  previousProviderExecutionId: false,
  providerExecutionId: false,
  state: false,
  fingerprint: true,
  resolutionJSON: true,
  decisionJSON: true,
  reservedAt: true,
  admittedAt: true,
};
const privateReviewFields = Object.fromEntries(
  Object.entries(reviewErasure)
    .filter(([, erase]) => erase)
    .map(([field]) => [`review.${field}`, 1]),
);
const privateResumeFields = Object.fromEntries(
  Object.entries(resumeErasure)
    .filter(([, erase]) => erase)
    .map(([field]) => [`resume.${field}`, 1]),
);

/** Retirement invalidates paused selection CASes before any physical target is removed. */
export function retiredResponseUpdate(now: Date = new Date()): UpdateQuery<StoredResponseRecord> {
  return {
    $set: { '_managed.phase': 'retired' },
    $min: { retiredAt: now },
    $inc: { revision: 1 },
    $unset: {
      requestJSON: 1,
      responseJSON: 1,
      ...privateReviewFields,
      ...privateResumeFields,
      preparedTerminal: 1,
      pendingTerminal: 1,
      terminalReceiptKey: 1,
    },
  };
}

/** One retained root bounds its immutable target map; target commands are batched by fixed kind. */
export async function finishResponseErasure(
  mongoose: typeof import('mongoose'),
  reference: ResponseReference,
): Promise<boolean> {
  const records = createStoredResponseModel(mongoose);
  const physical = responseRootCleanupFilter(mongoose, reference);
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
        return managedTargetPredicate(mongoose, target);
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
        releaseAcknowledged: true,
        $or: [
          { checkpoint: { $exists: false } },
          { 'checkpoint.state': 'settled', 'checkpoint.erased': true },
        ],
      },
    ],
  });
  return deleted.deletedCount === 1;
}

/** Historical cleanup stays explicitly owner-filtered even when strict mode denies unscoped queries. */
function inResponseErasurePartition<T>(owner: ResponseOwner, work: () => Promise<T>): Promise<T> {
  return tenantStorage.run(
    { tenantId: owner.tenantId || SYSTEM_TENANT_ID },
    async () => await work(),
  );
}

function responseErasureFilter(owner: ResponseOwner, conversationIds?: readonly string[]) {
  return {
    ...responseOwnerFilter(owner),
    ...(conversationIds ? { conversationId: { $in: conversationIds } } : {}),
    '_managed.phase': { $in: ['published', 'retired'] },
  };
}

/** Fence projection writers before the ordinary Conversation cascade removes its rows. */
export async function retireResponseRecords(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds: readonly string[],
): Promise<void> {
  assertResponseErasureOwner(owner);
  if (!conversationIds.length) return;
  await inResponseErasurePartition(owner, async () => {
    await readResponseErasureAdmission(mongoose, owner, conversationIds);
    await createStoredResponseModel(mongoose).updateMany(
      responseErasureFilter(owner, conversationIds),
      retiredResponseUpdate(),
      { upsert: false },
    );
  });
}

export async function eraseResponseRecords(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds?: readonly string[],
): Promise<void> {
  assertResponseErasureOwner(owner);
  if (conversationIds?.length === 0) return;
  await inResponseErasurePartition(owner, async () =>
    eraseOwnedResponses(mongoose, owner, conversationIds),
  );
}

export interface ResponseOwnerErasureMethods {
  prepareUserResponseErasure(owner: ResponseOwner): Promise<void>;
  eraseUserResponses(owner: ResponseOwner): Promise<void>;
}

/** Account erasure fences all owned admission before its existing checkpoint cleanup phase. */
export function createResponseOwnerErasureMethods(
  mongoose: typeof import('mongoose'),
): ResponseOwnerErasureMethods {
  const partitions = (owner: ResponseOwner) =>
    owner.tenantId ? [owner, { userId: owner.userId }] : [owner];
  return {
    async prepareUserResponseErasure(owner) {
      assertResponseErasureOwner(owner);
      for (const partition of partitions(owner))
        await inResponseErasurePartition(partition, async () =>
          closeResponseScopes(mongoose, partition),
        );
    },
    async eraseUserResponses(owner) {
      assertResponseErasureOwner(owner);
      for (const partition of partitions(owner))
        await runAsSystem(async () => eraseResponseRecords(mongoose, partition));
    },
  };
}

interface ResponseErasureConversation {
  conversationId: string;
  tenantId?: string;
}

interface ResponseErasureMetadata extends Partial<ResponseErasureConversation> {
  _id: import('mongoose').Types.ObjectId;
  userId?: string;
  _managed?: ManagedState;
}

/** Freeze exact pending allocations before erasing them. A winning publisher stays discoverable. */
async function retirePendingResponseRoots(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  roots: readonly Pick<ManagedRegistration, 'target'>[],
  allowedConversationKeys?: readonly string[],
): Promise<{ keys: string[]; conversations: ResponseErasureConversation[] }> {
  if (!roots.length) return { keys: [], conversations: [] };
  const records = createStoredResponseModel(mongoose);
  const ownerKey = responseScopeKeys(owner, '')[0];
  const physical = roots.map(({ target }) => {
    if (
      target.kind !== 'response' ||
      (target.tenantId || undefined) !== (owner.tenantId || undefined)
    )
      throw new Error('Response cleanup target tenant changed');
    return managedTargetPredicate(mongoose, target);
  });
  const read = () =>
    includeManagedAllocations(records.find({ $or: physical }))
      .select('_id userId tenantId conversationId +_managed')
      .read('primary')
      .lean<ResponseErasureMetadata[]>();
  const keys = new Set<string>();
  const capture = (rows: ResponseErasureMetadata[]) => {
    const conversations: ResponseErasureConversation[] = [];
    for (const row of rows) {
      const descriptor = row._managed;
      const key = descriptor?.conversationKey;
      if (
        descriptor?.ownerKey !== ownerKey ||
        !key ||
        !/^[a-f\d]{64}$/.test(key) ||
        (allowedConversationKeys && !allowedConversationKeys.includes(key))
      )
        throw new Error('Response cleanup root scope changed');
      keys.add(key);
      if (row.userId != null) {
        if (
          row.userId !== owner.userId ||
          !row.conversationId ||
          (row.tenantId || undefined) !== (owner.tenantId || undefined) ||
          responseScopeKeys(owner, row.conversationId)[1] !== key
        )
          throw new Error('Response cleanup published ownership changed');
        conversations.push({ conversationId: row.conversationId, tenantId: owner.tenantId });
      }
    }
    return conversations;
  };
  capture(await read());
  await closeResponseScopeKeys(mongoose, [...keys]);
  const placeholders = roots.map(({ target }, index) => ({
    ...physical[index],
    responseId: `${ALLOCATION_PREFIX}${target.id.toLowerCase()}`,
    userId: { $exists: false },
  }));
  await records.updateMany(
    {
      $or: placeholders,
      '_managed.phase': { $in: ['empty', 'pinned', 'registering', 'registered', 'retired'] },
    },
    { $set: { '_managed.phase': 'retired' } },
    { upsert: false },
  );
  await records.deleteMany({ $or: placeholders, '_managed.phase': 'retired' });
  // Publication can win the seal CAS; return that same physical Root, never a replacement.
  const conversations = capture(await read());
  await reconcileErasedResponseTargets(mongoose, owner, [...keys]);
  return { keys: [...keys], conversations };
}

/** Clear-history snapshots existing owner registrations without closing future owner admission. */
export async function* discoverResponseErasureConversations(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
): AsyncGenerator<ResponseErasureConversation[]> {
  assertResponseErasureOwner(owner);
  const partitions = owner.tenantId ? [owner, { userId: owner.userId }] : [owner];
  // Capture both bounded owner lists before any publication scan or settlement can remove entries.
  const snapshots = await Promise.all(
    partitions.map(async (partition) => ({
      owner: partition,
      pending:
        (
          await createResponseScopeModel(mongoose)
            .findById(responseScopeKeys(partition, '')[0])
            .select('pending')
            .read('primary')
            .lean()
        )?.pending ?? [],
    })),
  );
  for (const snapshot of snapshots) {
    const partition = <T>(work: () => Promise<T>) =>
      inResponseErasurePartition(snapshot.owner, work);
    {
      const pending = await partition(() =>
        retirePendingResponseRoots(
          mongoose,
          snapshot.owner,
          snapshot.pending.filter((entry) => entry.target.kind === 'response'),
        ),
      );
      if (pending.conversations.length) yield pending.conversations;
      const records = createStoredResponseModel(mongoose);
      let after: import('mongoose').Types.ObjectId | undefined;
      for (;;) {
        const page = await partition(() =>
          includeManagedAllocations(
            records.find({
              ...responseOwnerFilter(snapshot.owner),
              ...(after && { _id: { $gt: after } }),
            }),
          )
            .select('_id conversationId tenantId')
            .sort({ _id: 1 })
            .limit(ERASURE_BATCH_SIZE)
            .read('primary')
            .lean(),
        );
        if (!page.length) break;
        yield page.map((row) => ({
          conversationId: row.conversationId,
          tenantId: snapshot.owner.tenantId,
        }));
        after = page[page.length - 1]._id;
      }
    }
  }
}

async function readResponseErasureAdmission(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds?: readonly string[],
): Promise<{ ownerKey: string; ownerClosed: boolean; keys: string[] }> {
  const scopes = createResponseScopeModel(mongoose);
  const ownerKey = responseScopeKeys(owner, '')[0];
  const ownerAnchor = await scopes.findById(ownerKey).select('closed expiredAt').lean();
  const ownerClosed = Boolean(
    ownerAnchor?.closed || (ownerAnchor?.expiredAt && ownerAnchor.expiredAt <= new Date()),
  );
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
  return { ownerKey, ownerClosed, keys };
}

async function eraseOwnedResponses(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds?: readonly string[],
): Promise<void> {
  const scopes = createResponseScopeModel(mongoose);
  const records = createStoredResponseModel(mongoose);
  const { ownerKey, ownerClosed, keys } = await readResponseErasureAdmission(
    mongoose,
    owner,
    conversationIds,
  );
  await eraseChannelFeedbackForOwner(mongoose, owner, conversationIds);
  const relatedScopes = new Set(keys.filter((key) => key !== ownerKey));
  for (const key of keys) {
    // One authority has a configured bounded pending list; do not load all owners' lists.
    const anchor = await scopes.findById(key).select('closed expiredAt pending').lean();
    if (!anchor || (!anchor.closed && !(anchor.expiredAt && anchor.expiredAt <= new Date())))
      throw new Error('Response erasure requires closed admission');
    const roots = (anchor.pending ?? []).filter((entry) => entry.target.kind === 'response');
    await inResponseErasurePartition(owner, async () => {
      const retired = await retirePendingResponseRoots(
        mongoose,
        owner,
        roots,
        ownerClosed ? undefined : keys,
      );
      for (const key of retired.keys) relatedScopes.add(key);
      for (const kind of ['message', 'conversation'] as const) {
        const entries = (anchor.pending ?? []).filter((entry) => entry.target.kind === kind);
        if (!entries.length) continue;
        const child = mongoose.model(managedTargetModels[kind]);
        const exact = entries.map(({ target }) => {
          if ((target.tenantId || undefined) !== (owner.tenantId || undefined))
            throw new Error('Response cleanup target tenant changed');
          return managedTargetPredicate(mongoose, target);
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
  if (ownerClosed) {
    // An allocation may have its descriptor but crash before owner registration.
    // Closed owner admission prevents it from ever publishing private state.
    let after: import('mongoose').Types.ObjectId | undefined;
    for (;;) {
      const page = await includeManagedAllocations(
        records.find({
          '_managed.ownerKey': ownerKey,
          userId: { $exists: false },
          ...(after && { _id: { $gt: after } }),
        }),
      )
        .select('_id +_managed')
        .sort({ _id: 1 })
        .limit(ERASURE_BATCH_SIZE)
        .read('primary')
        .lean<ResponseErasureMetadata[]>();
      if (!page.length) break;
      const retired = await retirePendingResponseRoots(
        mongoose,
        owner,
        page.map((row) => {
          if (!row._managed?.incarnation)
            throw new Error('Response cleanup allocation identity is unavailable');
          return {
            target: {
              kind: 'response' as const,
              id: String(row._id),
              incarnation: row._managed.incarnation,
              ...(owner.tenantId && { tenantId: owner.tenantId }),
            },
          };
        }),
      );
      for (const key of retired.keys) relatedScopes.add(key);
      after = page[page.length - 1]._id;
    }
  }
  const filter = responseErasureFilter(owner, conversationIds);
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
