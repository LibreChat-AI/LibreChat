import { createHash } from 'crypto';
import type { CheckpointStorage, CheckpointCatalog } from './types';
import { checkpointOwnerNamespacePrefix } from './identity';
import { checkpointDatabase } from './database';

export const CHECKPOINT_STORAGE_COLLECTION = 'agent_checkpoint_stores';
export interface CheckpointStorageRecord {
  _id: string;
  owner: string;
  storage: CheckpointStorage;
}

export function checkpointStorageKey(storage: CheckpointStorage): string {
  const value = JSON.stringify([
    storage.type,
    storage.checkpointCollectionName,
    storage.checkpointWritesCollectionName,
  ]);
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createCheckpointCatalog(): CheckpointCatalog {
  return {
    async configurations(userId, tenantId) {
      const db = checkpointDatabase();
      const owners = (tenantId ? [tenantId, undefined] : [undefined]).map((tenant) =>
        checkpointOwnerNamespacePrefix(userId, tenant),
      );
      const records = await db
        .collection<CheckpointStorageRecord>(CHECKPOINT_STORAGE_COLLECTION)
        .find({ $or: owners.map((owner) => ({ _id: { $regex: `^${owner}` } })) })
        .toArray();
      return records.map(({ storage }) => storage);
    },
    references: ownedCheckpointReferences,
    async forgetDescriptors(userId, tenantId, stores) {
      const ids = stores.flatMap((storage) =>
        (tenantId ? [tenantId, undefined] : [undefined]).map(
          (tenant) =>
            `${checkpointOwnerNamespacePrefix(userId, tenant)}${checkpointStorageKey(storage)}`,
        ),
      );
      await checkpointDatabase()
        .collection<CheckpointStorageRecord>(CHECKPOINT_STORAGE_COLLECTION)
        .deleteMany({ _id: { $in: [...ids] } });
    },
  };
}

/** Capture exact owner-qualified identities, including orphan payload during owner-wide deletion. */
export async function* ownedCheckpointReferences(
  userId: string,
  tenantId: string | undefined,
  conversationIds: readonly string[] | undefined,
  storage: CheckpointStorage,
): AsyncGenerator<{
  conversationId: string;
  checkpoint: { threadId: string; checkpointNs: string; checkpointId: string };
}> {
  if (storage.type === 'memory') return;
  const db = checkpointDatabase();
  const owners = (tenantId ? [tenantId, undefined] : [undefined]).map((tenant) =>
    checkpointOwnerNamespacePrefix(userId, tenant),
  );
  for (let offset = 0; offset < (conversationIds?.length ?? 1); offset += 64) {
    const logicalIds = new Map<string, string>();
    for (const id of conversationIds?.slice(offset, offset + 64) ?? []) {
      logicalIds.set(id, id);
      for (const owner of owners) logicalIds.set(`${owner}${id}`, id);
    }
    for (const name of [storage.checkpointCollectionName, storage.checkpointWritesCollectionName]) {
      const cursor = db
        .collection<{
          thread_id: string;
          checkpoint_ns: string;
          checkpoint_id: string;
          lc_owner?: string;
          lc_parent_thread?: string;
        }>(name)
        .find(
          {
            ...(conversationIds == null
              ? {}
              : {
                  $and: [
                    {
                      $or: [
                        { thread_id: { $in: [...logicalIds.keys()] } },
                        { lc_parent_thread: { $in: conversationIds.slice(offset, offset + 64) } },
                      ],
                    },
                  ],
                }),
            $or: [
              ...owners.map((owner) => ({ checkpoint_ns: { $regex: `^${owner}` } })),
              { lc_owner: { $in: owners } },
            ],
          },
          {
            projection: {
              thread_id: 1,
              checkpoint_ns: 1,
              checkpoint_id: 1,
              lc_owner: 1,
              lc_parent_thread: 1,
            },
          },
        );
      for await (const row of cursor) {
        if (typeof row.checkpoint_id !== 'string' || typeof row.checkpoint_ns !== 'string')
          continue;
        const logicalThread =
          row.lc_owner != null &&
          owners.includes(row.lc_owner) &&
          row.thread_id.startsWith(row.lc_owner)
            ? row.thread_id.slice(row.lc_owner.length)
            : row.thread_id;
        yield {
          conversationId: row.lc_parent_thread ?? logicalIds.get(row.thread_id) ?? logicalThread,
          checkpoint: {
            threadId: row.thread_id,
            checkpointNs: row.checkpoint_ns,
            checkpointId: row.checkpoint_id,
          },
        };
      }
    }
  }
}
