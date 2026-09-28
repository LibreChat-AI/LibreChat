import mongoose from 'mongoose';
import { createHash } from 'crypto';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { ResolvedCheckpointerConfig } from './config';
import { checkpointOwnerNamespacePrefix } from '../../stream/checkpoints';
import { resolveCheckpointerConfig } from './config';

export const CHECKPOINT_STORAGE_COLLECTION = 'agent_checkpoint_stores';
export const LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY = '__librechat_checkpoint_storage_owner';
export type CheckpointStorage = Omit<ResolvedCheckpointerConfig, 'ttlSeconds'>;
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

/** Descriptors locate stores; caller ownership and captured identities authorize deletion. */
export async function checkpointStorageConfigs(
  userId: string,
  tenantId: string | undefined,
  cfg?: TCheckpointerConfig,
): Promise<ResolvedCheckpointerConfig[]> {
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1)
    throw new Error('Checkpoint database is unavailable');
  const owners = (tenantId ? [tenantId, undefined] : [undefined]).map((tenant) =>
    checkpointOwnerNamespacePrefix(userId, tenant),
  );
  const records = await db
    .collection<CheckpointStorageRecord>(CHECKPOINT_STORAGE_COLLECTION)
    .find({ $or: owners.map((owner) => ({ _id: { $regex: `^${owner}` } })) })
    .toArray();
  const configs = records.map(({ storage }) => resolveCheckpointerConfig(storage));
  configs.push(resolveCheckpointerConfig(cfg));
  return [...new Map(configs.map((storage) => [checkpointStorageKey(storage), storage])).values()];
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
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1)
    throw new Error('Checkpoint database is unavailable');
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
        }>(name)
        .find(
          {
            ...(conversationIds == null ? {} : { thread_id: { $in: [...logicalIds.keys()] } }),
            $or: [
              ...owners.map((owner) => ({ checkpoint_ns: { $regex: `^${owner}` } })),
              { lc_owner: { $in: owners } },
            ],
          },
          { projection: { thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1, lc_owner: 1 } },
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
          conversationId: logicalIds.get(row.thread_id) ?? logicalThread,
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
