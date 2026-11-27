import { randomUUID } from 'crypto';
import {
  logger,
  createCheckpointCatalog,
  createCheckpointDeletionJournal,
  checkpointDeletionTarget,
  createActorCheckpointPruning,
} from '@librechat/data-schemas';
import type {
  CheckpointCatalog,
  CheckpointDeletionJournal,
  ActorCheckpointPruning,
  CheckpointDeletionTarget,
} from '@librechat/data-schemas';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import { deleteOwnedAgentCheckpoints, deleteAgentEventCheckpointReferences } from '../checkpointer';
import { checkpointStorageKey, checkpointStorageConfigs } from './storage';
import { checkpointOwnerNamespacePrefix } from '../../stream/checkpoints';
import { historicalActorReferences } from './pruning';

interface CheckpointDeletionStorage {
  catalog: CheckpointCatalog;
  journal: CheckpointDeletionJournal;
  pruning: ActorCheckpointPruning;
}
function deletionStorage(): CheckpointDeletionStorage {
  return {
    catalog: createCheckpointCatalog(),
    journal: createCheckpointDeletionJournal(),
    pruning: createActorCheckpointPruning(),
  };
}

export interface CheckpointDeletion {
  conversationIds(): string[];
  remember(conversationIds: readonly string[]): Promise<void>;
  cleanup(): Promise<void>;
  acknowledge(): Promise<void>;
}

/** Durable deletion intent preserves cascade identity after topology is removed.
 * These records contain no checkpoint payload and exist only during deletion,
 * not once per generation. They must survive until both drain and cleanup succeed. */
export async function openCheckpointDeletion(
  userId: string,
  tenantId: string | undefined,
  rootConversationId: string | undefined,
  cfg?: TCheckpointerConfig,
  persistence: CheckpointDeletionStorage = deletionStorage(),
): Promise<CheckpointDeletion> {
  if (!userId) {
    throw new Error('Checkpoint deletion requires an owner');
  }
  const { catalog, journal, pruning } = persistence;
  const storageKey = checkpointStorageKey;
  const ownerPrefix = checkpointOwnerNamespacePrefix(userId, tenantId);
  const tenants = tenantId ? [tenantId, undefined] : [undefined];
  const retained = await journal.retained(userId, tenantId, rootConversationId);
  const targets = new Map(retained.map((target) => [target.id, target]));
  const stores = new Map(retained.map((target) => [storageKey(target.storage), target.storage]));
  async function refreshStores() {
    for (const storage of await checkpointStorageConfigs(userId, tenantId, cfg, catalog)) {
      stores.set(storageKey(storage), storage);
    }
  }
  await refreshStores();
  const version = randomUUID();
  const scope = { userId, tenantId, rootConversationId };
  const targetFor = (
    storage: CheckpointDeletionTarget['storage'],
    threadId: string,
    checkpoint?: CheckpointDeletionTarget['checkpoint'],
    proof?: 'owned' | 'historical',
  ) => checkpointDeletionTarget(scope, storage, threadId, version, checkpoint, proof);
  const batchSize = 256;

  async function persist(batch: CheckpointDeletionTarget[]) {
    await journal.remember(batch);
    for (const target of batch) targets.set(target.id, target);
  }

  const conversationIds = () => [
    ...new Set([...targets.values()].map((target) => target.threadId)),
  ];
  async function captureOwned(ids: readonly string[] | undefined) {
    let batch: CheckpointDeletionTarget[] = [];
    for (const storage of stores.values()) {
      for await (const { checkpoint, conversationId } of catalog.references(
        userId,
        tenantId,
        ids,
        storage,
      )) {
        batch.push(targetFor(storage, conversationId, checkpoint, 'owned'));
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
        for (const storage of stores.values()) {
          await persist(threads.map((threadId) => targetFor(storage, threadId)));
        }
        await captureOwned(threads);
        let batch: CheckpointDeletionTarget[] = [];
        for await (const checkpoint of historicalActorReferences(
          userId,
          tenantId,
          threads,
          pruning,
        )) {
          for (const storage of stores.values()) {
            batch.push(targetFor(storage, checkpoint.threadId, checkpoint, 'historical'));
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
      const groups = new Map(
        [...stores.keys()].map((key) => [key, [] as CheckpointDeletionTarget[]]),
      );
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
        await journal.acknowledge(receipts.slice(offset, offset + batchSize));
      }
      if (rootConversationId != null) return;
      if (await journal.hasPending(userId, tenantId, rootConversationId))
        throw new Error('Checkpoint deletion intent is still pending');
      // Owner-wide callers retain their deletion fence through acknowledgement.
      const descriptors = [...stores.values()];
      for (let offset = 0; offset < descriptors.length; offset += batchSize) {
        await catalog.forgetDescriptors(
          userId,
          tenantId,
          descriptors.slice(offset, offset + batchSize),
        );
      }
    },
  };
}

/** Replay captured identities after topology deletion; never sweep new generations. */
export function createCheckpointDeletionReclaimer(
  getOwnerJobs: (userId: string, tenantId?: string) => Promise<string[]>,
  journal: CheckpointDeletionJournal = createCheckpointDeletionJournal(),
): (limit: number, activity?: { found: boolean }) => Promise<number> {
  let after: string | undefined;
  return async (limit, activity) => {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid reclamation limit');
    const targets = await journal.scan(limit, after);
    if (activity != null && targets.length > 0) activity.found = true;
    after = targets.length === limit ? targets[targets.length - 1].id : undefined;
    const jobsByOwner = new Map<string, Promise<string[]>>();

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
          if (!(await journal.hasConversation(target.userId, target.threadId))) {
            for (const tenant of target.tenantId ? [target.tenantId, undefined] : [undefined]) {
              await deleteAgentEventCheckpointReferences(
                [target.checkpoint],
                checkpointOwnerNamespacePrefix(target.userId, tenant),
                { ...target.storage, ttl: target.storage.ttlSeconds },
              );
            }
          }
        }
        if (await journal.hasPersistence(target)) return 0;
        return journal.reclaim(target);
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
