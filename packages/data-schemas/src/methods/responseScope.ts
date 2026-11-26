import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { ResponseOwner } from '~/models/response';
import {
  eraseChannelFeedbackForOwner,
  retainChannelFeedbackForOwner,
} from './channelFeedbackErasure';
import { createResponseScopeModel } from '~/models/responseScope';
import { createStoredResponseModel } from '~/models/response';
import { getTransactionSupport } from '~/utils/transactions';
import { createIndexesWithRetry } from '~/utils/retry';
import { runAsSystem } from '~/config/tenantContext';

/** Response-bound conversation IDs are immutable: jobs and checkpoints retain that identity.
 * An empty source scope is closed before replacement so delayed admission cannot orphan data. */
export function createResponseConversationReplacement(
  mongoose: typeof import('mongoose'),
): (owner: ResponseOwner, conversationId: string) => Promise<boolean> {
  let supported: boolean | null = null;
  return async (owner, conversationId) => {
    supported = await getTransactionSupport(mongoose, supported);
    const records = createStoredResponseModel(mongoose);
    const filter = { ...responseOwnerFilter(owner), conversationId };
    if (!supported) {
      // Reservation fails closed on standalone deployments, so no admission can race this check.
      if (await records.exists(filter)) return false;
      await closeResponseScopes(mongoose, owner, [conversationId]);
      return true;
    }
    const key = responseScopeKeys(owner, conversationId)[1];
    await initializeResponseScopes(mongoose, [key]);
    const session = await mongoose.startSession({
      defaultTransactionOptions: { readPreference: 'primary' },
    });
    try {
      let allowed = false;
      await session.withTransaction(async () => {
        const scopes = createResponseScopeModel(mongoose);
        // Serialize with the reservation's write to this same anchor before checking rows.
        await scopes.updateOne({ _id: key }, { $inc: { revision: 1 } }, { session });
        if (await records.exists(filter).session(session)) {
          allowed = false;
          return;
        }
        await scopes.updateOne({ _id: key }, { $set: { closed: true } }, { session });
        allowed = true;
      });
      return allowed;
    } finally {
      await session.endSession();
    }
  };
}

/** Authorized missing-root recovery, restricted to one globally unique owner/conversation. */
export async function discoverResponseOwners(
  mongoose: typeof import('mongoose'),
  userId: string,
  conversationId: string,
): Promise<ResponseOwner[]> {
  return runAsSystem(async () => {
    const model = createStoredResponseModel(mongoose);
    const filter = { userId, conversationId };
    const [tenants, tenantless] = await Promise.all([
      model.distinct('tenantId', filter),
      model.exists({ ...filter, tenantId: { $in: [null, ''] } }),
    ]);
    const owners: ResponseOwner[] = tenants
      .filter((tenantId): tenantId is string => typeof tenantId === 'string' && tenantId !== '')
      .map((tenantId) => ({ userId, tenantId }));
    if (tenantless) owners.push({ userId });
    return owners;
  });
}

/** Retention intent is monotonic, like erasure: failed parent saves never reopen private data. */
export function createResponseRetention(
  mongoose: typeof import('mongoose'),
  parentSession?: ClientSession,
): (owner: ResponseOwner, conversationId: string, expiredAt: Date) => Promise<void> {
  let supported: boolean | null = null;
  let indexes: Promise<void> | undefined;
  return async (owner, conversationId, expiredAt) => {
    if (!(expiredAt instanceof Date) || !Number.isFinite(expiredAt.getTime()))
      throw new TypeError('Invalid response expiration');
    const key = responseScopeKeys(owner, conversationId)[1];
    await initializeResponseScopes(mongoose, [key], parentSession);
    const scopes = createResponseScopeModel(mongoose);
    const records = createStoredResponseModel(mongoose);
    supported = parentSession ? true : await getTransactionSupport(mongoose, supported);
    if (supported && !parentSession) {
      indexes ??= createIndexesWithRetry(records)
        .then(() => undefined)
        .catch((error: unknown) => {
          indexes = undefined;
          throw error;
        });
      await indexes;
    }
    const apply = async (session?: import('mongoose').ClientSession) => {
      const anchor = await scopes
        .findOneAndUpdate(
          { _id: key },
          { $min: { expiredAt }, $inc: { revision: 1 } },
          { new: true, ...(session ? { session } : {}) },
        )
        .lean();
      if (!anchor?.expiredAt) throw new Error('Response retention scope unavailable');
      await records.updateMany(
        {
          ...responseOwnerFilter(owner),
          conversationId,
          $or: [{ expiredAt: null }, { expiredAt: { $gt: anchor.expiredAt } }],
        },
        { $set: { expiredAt: anchor.expiredAt } },
        session ? { session } : {},
      );
      await retainChannelFeedbackForOwner(
        mongoose,
        owner,
        conversationId,
        anchor.expiredAt,
        session,
      );
    };
    if (parentSession) return apply(parentSession);
    if (!supported) return apply();
    const session = await mongoose.startSession({
      defaultTransactionOptions: { readPreference: 'primary' },
    });
    try {
      await session.withTransaction(() => apply(session));
    } finally {
      await session.endSession();
    }
  };
}

/** The tenant policy treats missing, null and empty tenant IDs as one partition. */
export function responseOwnerFilter(owner: ResponseOwner): {
  userId: string;
  tenantId: string | { $in: Array<null | string> };
} {
  return { userId: owner.userId, tenantId: owner.tenantId || { $in: [null, ''] } };
}

export async function eraseResponseRecords(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds?: readonly string[],
): Promise<void> {
  await eraseChannelFeedbackForOwner(mongoose, owner, conversationIds);
  await createStoredResponseModel(mongoose).deleteMany({
    ...responseOwnerFilter(owner),
    ...(conversationIds ? { conversationId: { $in: conversationIds } } : {}),
  });
}

function scopeKey(owner: ResponseOwner, conversationId?: string): string {
  return createHash('sha256')
    .update(JSON.stringify([owner.tenantId || null, owner.userId, conversationId ?? null]))
    .digest('hex');
}

export function responseScopeKeys(owner: ResponseOwner, conversationId: string): string[] {
  return [scopeKey(owner), scopeKey(owner, conversationId)];
}

/** Create once: a delayed nontransactional upsert can replace newer state on some engines. */
async function seedScopes(
  mongoose: typeof import('mongoose'),
  keys: string[],
  closed: boolean,
  session?: ClientSession,
): Promise<void> {
  const model = createResponseScopeModel(mongoose);
  if (session?.inTransaction()) {
    // Preserve the caller's snapshot. Any error belongs to its transaction owner;
    // recovering a duplicate here could query an already-aborted transaction.
    for (const key of keys)
      await model.updateOne(
        { _id: key },
        { $setOnInsert: { closed, revision: 0 } },
        { upsert: true, session },
      );
    return;
  }
  // A supplied, inactive session retains its causal history but starts no transaction.
  const existing = await model
    .find({ _id: { $in: keys } })
    .select('_id')
    .read('primary')
    .session(session ?? null)
    .lean();
  const found = new Set(existing.map((row) => row._id));
  const missing = keys.filter((key) => !found.has(key));
  if (!missing.length) return;
  if (mongoose.connection.db?.writeConcern?.w === 0)
    throw new Error('Response scope creation requires acknowledged writes');
  try {
    // eslint-disable-next-line no-restricted-syntax -- payload-free anchors hash the validated owner/tenant; insert-only creation never mutates an existing anchor.
    const created = await model.bulkWrite(
      missing.map((key) => ({ insertOne: { document: { _id: key, closed, revision: 0 } } })),
      { ordered: false, session },
    );
    if (created.insertedCount !== missing.length)
      throw new Error('Response scope creation was not acknowledged');
  } catch (error) {
    if (!(error instanceof mongoose.mongo.MongoBulkWriteError)) throw error;
    const errors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
    if (
      !errors.length ||
      errors.some((entry) => entry.code !== 11000) ||
      error.result.getWriteConcernError()
    )
      throw error;
    const present = await model
      .countDocuments({ _id: { $in: missing } })
      .read('primary')
      .session(session ?? null);
    if (present !== missing.length) throw error;
  }
}

/** Initializes only metadata; a late initializer can never reopen an erased scope. */
export async function initializeResponseScopes(
  mongoose: typeof import('mongoose'),
  keys: string[],
  session?: ClientSession,
): Promise<void> {
  const unique = [...new Set(keys)];
  for (let offset = 0; offset < unique.length; offset += 250)
    await seedScopes(mongoose, unique.slice(offset, offset + 250), false, session);
}

export async function isResponseScopeClosed(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string,
): Promise<boolean> {
  return (
    (await createResponseScopeModel(mongoose).exists({
      _id: { $in: responseScopeKeys(owner, conversationId) },
      $or: [{ closed: true }, { expiredAt: { $lte: new Date() } }],
    })) != null
  );
}

/** Irreversible deletion intent. Ordinary retries complete erasure without readmitting work. */
export async function closeResponseScopes(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds?: string[],
): Promise<void> {
  const model = createResponseScopeModel(mongoose);
  const keys = [...new Set(conversationIds?.map((id) => scopeKey(owner, id)) ?? [scopeKey(owner)])];
  // Bound both creation and mutation independently of the number of conversations.
  for (let offset = 0; offset < keys.length; offset += 250) {
    const batch = keys.slice(offset, offset + 250);
    await seedScopes(mongoose, batch, true);
    const operations = batch.map((key) => ({
      updateOne: {
        filter: { _id: key },
        update: { $set: { closed: true } },
        upsert: false,
      },
    }));
    // eslint-disable-next-line no-restricted-syntax -- payload-free anchors use the validated tenant/owner scope hash and cannot be recreated by this mutation.
    const closed = await model.bulkWrite(operations, { ordered: false });
    if (closed.matchedCount !== batch.length)
      throw new Error('Response scope closure was not acknowledged');
  }
  await createStoredResponseModel(mongoose).updateMany(
    {
      ...responseOwnerFilter(owner),
      ...(conversationIds ? { conversationId: { $in: conversationIds } } : {}),
      status: { $in: ['queued', 'in_progress', 'requires_action', 'materializing'] },
      cancellationRequestedAt: { $exists: false },
      pendingTerminal: { $exists: false },
    },
    { $set: { cancellationRequestedAt: Date.now() } },
  );
}
