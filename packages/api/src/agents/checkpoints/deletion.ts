import mongoose from 'mongoose';
import { createHash, randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { AgentEventCheckpointReference } from '../checkpointer';
import type { ResolvedCheckpointerConfig } from './config';
import type { CheckpointStorageRecord } from './storage';
import {
  checkpointStorageKey,
  checkpointStorageConfigs,
  ownedCheckpointReferences,
  CHECKPOINT_STORAGE_COLLECTION,
} from './storage';
import { deleteOwnedAgentCheckpoints, deleteAgentEventCheckpointReferences } from '../checkpointer';
import { checkpointOwnerNamespacePrefix } from '../../stream/checkpoints';
import { historicalActorReferences } from './pruning';

interface DeletionTarget {
  _id: string;
  version: string;
  threadId: string;
  checkpoint?: AgentEventCheckpointReference;
  userId: string;
  tenantId?: string;
  storage: ResolvedCheckpointerConfig;
}

const DELETION_COLLECTION = 'agent_checkpoint_deletions';

export interface CheckpointDeletion {
  conversationIds(): string[];
  remember(conversationIds: readonly string[]): Promise<void>;
  cleanup(): Promise<void>;
  acknowledge(): Promise<void>;
}

const hash = (value: string | null) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Durable deletion intent preserves cascade identity after topology is removed.
 * These records contain no checkpoint payload and exist only during deletion,
 * not once per generation. They must survive until both drain and cleanup succeed. */
export async function openCheckpointDeletion(
  userId: string,
  tenantId: string | undefined,
  rootConversationId: string | undefined,
  cfg?: TCheckpointerConfig,
): Promise<CheckpointDeletion> {
  if (!userId) {
    throw new Error('Checkpoint deletion requires an owner');
  }
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) {
    throw new Error('Checkpoint database is unavailable');
  }
  const collection = db.collection<DeletionTarget>(DELETION_COLLECTION);
  const storageKey = checkpointStorageKey;
  const ownerPrefix = checkpointOwnerNamespacePrefix(userId, tenantId);
  const tenants = tenantId ? [tenantId, undefined] : [undefined];
  const prefixes = tenants.map((tenant) => {
    const prefix = checkpointOwnerNamespacePrefix(userId, tenant);
    return rootConversationId == null
      ? prefix
      : `${prefix}[0-9a-f]{64}:${hash(rootConversationId)}:`;
  });
  const retained = await collection
    .find({ $or: prefixes.map((prefix) => ({ _id: { $regex: `^${prefix}` } })) })
    .toArray();
  const targets = new Map(retained.map((target) => [target._id, target]));
  const stores = new Map(retained.map((target) => [storageKey(target.storage), target.storage]));
  async function refreshStores() {
    for (const storage of await checkpointStorageConfigs(userId, tenantId, cfg)) {
      stores.set(storageKey(storage), storage);
    }
  }
  await refreshStores();
  const version = randomUUID();
  const batchSize = 256;

  async function persist(batch: DeletionTarget[]) {
    await collection.bulkWrite(
      batch.map((target) => ({
        updateOne: {
          filter: { _id: target._id },
          update: {
            $set: {
              version,
              threadId: target.threadId,
              userId,
              tenantId,
              storage: target.storage,
              ...(target.checkpoint && { checkpoint: target.checkpoint }),
            },
          },
          upsert: true,
        },
      })),
    );
    for (const target of batch) targets.set(target._id, target);
  }

  const conversationIds = () => [
    ...new Set([...targets.values()].map((target) => target.threadId)),
  ];
  async function captureOwned(ids: readonly string[] | undefined) {
    let batch: DeletionTarget[] = [];
    for (const [key, storage] of stores) {
      const rootPrefix = `${ownerPrefix}${key}:${hash(rootConversationId ?? null)}:`;
      for await (const { checkpoint, conversationId } of ownedCheckpointReferences(
        userId,
        tenantId,
        ids,
        storage,
      )) {
        batch.push({
          _id: `${rootPrefix}${hash(conversationId)}:${hash(JSON.stringify([checkpoint.threadId, checkpoint.checkpointNs, checkpoint.checkpointId]))}`,
          version,
          threadId: conversationId,
          userId,
          tenantId,
          storage,
          checkpoint,
        });
        if (batch.length === batchSize) {
          await persist(batch);
          batch = [];
        }
      }
    }
    if (batch.length > 0) await persist(batch);
  }
  return {
    conversationIds,
    async remember(ids: readonly string[]) {
      await refreshStores();
      for (let offset = 0; offset < ids.length; offset += batchSize) {
        const threads = ids.slice(offset, offset + batchSize);
        for (const [key, storage] of stores) {
          const rootPrefix = `${ownerPrefix}${key}:${hash(rootConversationId ?? null)}:`;
          await persist(
            threads.map((threadId) => ({
              _id: `${rootPrefix}${hash(threadId)}`,
              version,
              threadId,
              userId,
              tenantId,
              storage,
            })),
          );
        }
        await captureOwned(threads);
        let batch: DeletionTarget[] = [];
        for await (const checkpoint of historicalActorReferences(userId, tenantId, threads)) {
          for (const [key, storage] of stores) {
            const rootPrefix = `${ownerPrefix}${key}:${hash(rootConversationId ?? null)}:`;
            batch.push({
              _id: `${rootPrefix}${hash(checkpoint.threadId)}:${hash(JSON.stringify([checkpoint.checkpointNs, checkpoint.checkpointId]))}`,
              version,
              threadId: checkpoint.threadId,
              userId,
              tenantId,
              storage,
              checkpoint,
            });
            if (batch.length === batchSize) {
              await persist(batch);
              batch = [];
            }
          }
        }
        if (batch.length > 0) await persist(batch);
      }
    },
    async cleanup() {
      await refreshStores();
      await captureOwned(rootConversationId == null ? undefined : conversationIds());
      const groups = new Map([...stores.keys()].map((key) => [key, [] as DeletionTarget[]]));
      for (const target of targets.values()) groups.get(storageKey(target.storage))!.push(target);
      for (const [key, storage] of stores) {
        const group = groups.get(key)!;
        const storedConfig = { ...storage, ttl: storage.ttlSeconds };
        const ids =
          rootConversationId == null
            ? undefined
            : [...new Set(group.map((target) => target.threadId))];
        for (const tenant of tenants) {
          await deleteOwnedAgentCheckpoints(userId, tenant, ids, storedConfig);
        }
        await deleteAgentEventCheckpointReferences(
          group.flatMap((target) => target.checkpoint ?? []),
          ownerPrefix,
          storedConfig,
        );
      }
    },
    async acknowledge() {
      const receipts = [...targets.values()];
      for (let offset = 0; offset < receipts.length; offset += batchSize) {
        await collection.deleteMany({
          $or: receipts.slice(offset, offset + batchSize).map(({ _id, version: captured }) => ({
            _id,
            version: captured,
          })),
        });
      }
      if (rootConversationId != null) return;
      const pending = await collection.findOne(
        { $or: prefixes.map((prefix) => ({ _id: { $regex: `^${prefix}` } })) },
        { projection: { _id: 1 } },
      );
      if (pending != null) throw new Error('Checkpoint deletion intent is still pending');
      // Owner-wide callers retain their deletion fence through acknowledgement.
      const descriptors = [...stores.keys()].flatMap((key) =>
        tenants.map((tenant) => `${checkpointOwnerNamespacePrefix(userId, tenant)}${key}`),
      );
      for (let offset = 0; offset < descriptors.length; offset += batchSize) {
        await db.collection<CheckpointStorageRecord>(CHECKPOINT_STORAGE_COLLECTION).deleteMany({
          _id: { $in: descriptors.slice(offset, offset + batchSize) },
        });
      }
    },
  };
}

/** Replay captured identities after topology deletion; never sweep new generations. */
export function createCheckpointDeletionReclaimer(
  getOwnerJobs: (userId: string, tenantId?: string) => Promise<string[]>,
): (limit: number, activity?: { found: boolean }) => Promise<number> {
  let after: string | undefined;
  return async (limit, activity) => {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid reclamation limit');
    const db = mongoose.connection.db;
    if (!db || mongoose.connection.readyState !== 1)
      throw new Error('Checkpoint database is unavailable');
    const collection = db.collection<DeletionTarget>(DELETION_COLLECTION);
    const targets = await collection
      .find(after == null ? {} : { _id: { $gt: after } })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    if (activity != null && targets.length > 0) activity.found = true;
    after = targets.length === limit ? targets[targets.length - 1]._id : undefined;
    const jobsByOwner = new Map<string, Promise<string[]>>();

    const hasPersistence = async (target: DeletionTarget): Promise<boolean> => {
      const { userId, tenantId, threadId, checkpoint, storage } = target;
      const owners = (tenantId ? [tenantId, undefined] : [undefined]).map((tenant) =>
        checkpointOwnerNamespacePrefix(userId, tenant),
      );
      const user = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : userId;
      const siblingCollections = [
        [mongoose.models.Conversation?.collection.name ?? 'conversations', userId],
        [mongoose.models.Message?.collection.name ?? 'messages', userId],
        [mongoose.models.ToolCall?.collection.name ?? 'toolcalls', user],
        [mongoose.models.SharedLink?.collection.name ?? 'sharedlinks', userId],
      ] as const;
      const siblings = siblingCollections.map(([name, owner]) =>
        db
          .collection(name)
          .findOne({ user: owner, conversationId: threadId }, { projection: { _id: 1 } }),
      );
      const payload =
        storage.type === 'memory'
          ? []
          : [storage.checkpointCollectionName, storage.checkpointWritesCollectionName].map((name) =>
              db.collection(name).findOne(
                {
                  $or: [
                    ...owners.map((owner) => ({
                      thread_id: { $in: [threadId, `${owner}${threadId}`] },
                      $or: [{ checkpoint_ns: { $regex: `^${owner}` } }, { lc_owner: owner }],
                    })),
                    ...(checkpoint == null
                      ? []
                      : [
                          {
                            thread_id: checkpoint.threadId,
                            checkpoint_ns: checkpoint.checkpointNs,
                            checkpoint_id: checkpoint.checkpointId,
                            $or: [{ lc_owner: { $in: owners } }, { lc_owner: { $exists: false } }],
                          },
                        ]),
                  ],
                },
                { projection: { _id: 1 } },
              ),
            );
      return (await Promise.all([...siblings, ...payload])).some((row) => row != null);
    };

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        const owner = checkpointOwnerNamespacePrefix(target.userId, target.tenantId);
        let jobs = jobsByOwner.get(owner);
        if (jobs == null) {
          jobs = getOwnerJobs(target.userId, target.tenantId);
          jobsByOwner.set(owner, jobs);
        }
        if ((await jobs).length > 0) return 0;
        if (target.checkpoint != null) {
          const conversation = await db
            .collection(mongoose.models.Conversation?.collection.name ?? 'conversations')
            .findOne(
              { user: target.userId, conversationId: target.threadId },
              { projection: { _id: 1 } },
            );
          if (conversation == null) {
            for (const tenant of target.tenantId ? [target.tenantId, undefined] : [undefined]) {
              await deleteAgentEventCheckpointReferences(
                [target.checkpoint],
                checkpointOwnerNamespacePrefix(target.userId, tenant),
                { ...target.storage, ttl: target.storage.ttlSeconds },
              );
            }
          }
        }
        if (await hasPersistence(target)) return 0;
        return (await collection.deleteOne({ _id: target._id, version: target.version }))
          .deletedCount;
      }),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      for (const failure of failures)
        logger.error('[checkpoints] Deletion evidence reclamation failed:', failure.reason);
      throw new Error('Checkpoint evidence reclamation failed');
    }
    return results.reduce(
      (count, result) => count + (result.status === 'fulfilled' ? result.value : 0),
      0,
    );
  };
}
