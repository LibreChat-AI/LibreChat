import mongoose from 'mongoose';
import type { Filter, Binary, Db, MongoClient } from 'mongodb';
import type {
  CheckpointRepository,
  CheckpointIdentity,
  CheckpointReference,
  CheckpointSelection,
  SerializedCheckpoint,
  SerializedCheckpointWrite,
  CheckpointGeneration,
} from './types';
import { checkpointStorageKey, CHECKPOINT_STORAGE_COLLECTION } from './catalog';
import { checkpointOwnerNamespacePrefix } from './identity';
import { buildIndexWithRetry } from '../utils';
import logger from '../config/winston';

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  lc_owner?: string;
  type: string;
  checkpoint: Binary;
  metadata: Binary;
  metadata_search: Record<string, unknown>;
}
interface WriteRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: Binary;
  lc_owner?: string;
}

export interface MongoCheckpointRepositoryOptions {
  client?: Pick<MongoClient, 'db'>;
  dbName?: string;
  checkpointCollectionName?: string;
  checkpointWritesCollectionName?: string;
  enableTimestamps?: boolean;
  ttl?: number;
}

function generationNamespaceFilter(namespace: string): string | { $regex: string } {
  if (namespace === '') return '';
  return { $regex: `^${namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[|]|$)` };
}
function legacyCheckpointStorageFilter() {
  return { checkpoint_ns: { $not: /^lcg:v2:/ }, lc_owner: { $exists: false } };
}
function physical(key: CheckpointIdentity) {
  return {
    thread_id: `${key.owner ?? ''}${key.threadId}`,
    checkpoint_ns: `${key.owner ?? ''}${key.checkpointNs}`,
    ...(key.checkpointId == null ? {} : { checkpoint_id: key.checkpointId }),
    ...(key.owner == null ? {} : { lc_owner: key.owner }),
  };
}
function decode(row: CheckpointRow, owner?: string): SerializedCheckpoint {
  return {
    identity: {
      threadId:
        owner && row.thread_id.startsWith(owner)
          ? row.thread_id.slice(owner.length)
          : row.thread_id,
      checkpointNs:
        owner && row.checkpoint_ns.startsWith(owner)
          ? row.checkpoint_ns.slice(owner.length)
          : row.checkpoint_ns,
      checkpointId: row.checkpoint_id,
    },
    parentCheckpointId: row.parent_checkpoint_id ?? undefined,
    checkpoint: { type: row.type, bytes: row.checkpoint.value() },
    metadata: { type: row.type, bytes: row.metadata.value() },
    metadataSearch: row.metadata_search,
  };
}

/** Uses the selected app database, or an explicitly supplied client for constructor compatibility. */
export function createMongoCheckpointRepository(
  options: MongoCheckpointRepositoryOptions = {},
): CheckpointRepository {
  const db = options.client?.db(options.dbName) ?? mongoose.connection.db;
  if (!db || (!options.client && mongoose.connection.readyState !== 1))
    throw new Error('Checkpoint database is unavailable');
  return new MongoCheckpointRepository(db, options);
}

class MongoCheckpointRepository implements CheckpointRepository {
  private readonly checkpoints: string;
  private readonly writes: string;
  private readonly timestamps: boolean;
  constructor(
    private readonly db: Db,
    private readonly options: MongoCheckpointRepositoryOptions,
  ) {
    this.checkpoints = options.checkpointCollectionName ?? 'checkpoints';
    this.writes = options.checkpointWritesCollectionName ?? 'checkpoint_writes';
    this.timestamps = (options.enableTimestamps ?? false) || options.ttl != null;
  }
  private async recordStorage(key: CheckpointIdentity, storageOwner?: string): Promise<void> {
    const candidate =
      key.owner ?? key.checkpointNs.match(/^lcg:v2:[0-9a-f]{64}:/)?.[0] ?? storageOwner;
    if (typeof candidate !== 'string' || !/^lcg:v2:[0-9a-f]{64}:$/.test(candidate)) return;
    const storage = {
      type: 'mongo' as const,
      checkpointCollectionName: this.checkpoints,
      checkpointWritesCollectionName: this.writes,
    };
    await this.db
      .collection<{ _id: string }>(CHECKPOINT_STORAGE_COLLECTION)
      .updateOne(
        { _id: `${candidate}${checkpointStorageKey(storage)}` },
        { $setOnInsert: { owner: candidate, storage } },
        { upsert: true },
      );
  }
  async setup(): Promise<Error[]> {
    // Return individual errors; setupCheckpointIndexes owns the batch retry deadline.
    const options = { maxAttempts: 1, peerBuildDeadlineMs: 0 };
    const operations = [
      buildIndexWithRetry(
        () =>
          this.db
            .collection(this.checkpoints)
            .createIndex(
              { thread_id: 1, checkpoint_ns: 1, checkpoint_id: -1 },
              { name: 'thread_ns_checkpoint_idx' },
            ),
        `${this.checkpoints}.thread_ns_checkpoint_idx`,
        options,
      ),
      buildIndexWithRetry(
        () =>
          this.db
            .collection(this.writes)
            .createIndex(
              { thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1, task_id: 1, idx: 1 },
              { name: 'thread_ns_checkpoint_task_idx' },
            ),
        `${this.writes}.thread_ns_checkpoint_task_idx`,
        options,
      ),
    ];
    if (this.options.ttl != null)
      for (const name of [this.checkpoints, this.writes])
        operations.push(
          buildIndexWithRetry(
            () =>
              this.db
                .collection(name)
                .createIndex({ upserted_at: 1 }, { expireAfterSeconds: this.options.ttl }),
            `${name}.checkpoint_expiry`,
            options,
          ),
        );
    return (await Promise.allSettled(operations)).flatMap((result) =>
      result.status === 'rejected' ? [result.reason as Error] : [],
    );
  }
  async setupOwnershipIndexes(): Promise<void> {
    const indexes: Record<string, 1>[] = [
      { checkpoint_ns: 1 },
      { lc_owner: 1, thread_id: 1 },
      { lc_parent_thread: 1 },
    ];
    for (const index of indexes) {
      await Promise.all(
        [this.checkpoints, this.writes].map(async (name) => {
          try {
            await buildIndexWithRetry(
              () => this.db.collection(name).createIndex(index),
              `${name}.checkpoint_ownership`,
            );
          } catch (error) {
            logger.warn('[checkpointer] Cleanup index unavailable:', error);
          }
        }),
      );
    }
  }
  async get(key: CheckpointIdentity): Promise<SerializedCheckpoint | null> {
    const checkpoints = this.db.collection<CheckpointRow>(this.checkpoints);
    let row = await checkpoints.find(physical(key)).sort({ checkpoint_id: -1 }).limit(1).next();
    if (
      row == null &&
      key.owner != null &&
      key.checkpointId != null &&
      key.checkpointId === key.legacyCheckpointId
    ) {
      row = await checkpoints.findOne({
        thread_id: key.threadId,
        checkpoint_ns: key.checkpointNs,
        checkpoint_id: key.checkpointId,
        lc_owner: { $exists: false },
      });
    }
    return row == null ? null : decode(row, key.owner);
  }
  async *list(selection: CheckpointSelection): AsyncGenerator<SerializedCheckpoint> {
    const query: Filter<CheckpointRow> = {
      ...(selection.threadId ? { thread_id: `${selection.owner ?? ''}${selection.threadId}` } : {}),
      ...(selection.checkpointNs == null
        ? {}
        : { checkpoint_ns: `${selection.owner ?? ''}${selection.checkpointNs}` }),
      ...(selection.owner == null ? {} : { lc_owner: selection.owner }),
    };
    for (const [name, value] of Object.entries(selection.metadata ?? {})) {
      if (value !== null && typeof value === 'object')
        throw new Error('Checkpoint metadata filters must be primitive');
      query[`metadata_search.${name}`] = value;
    }
    if (selection.before != null) query.checkpoint_id = { $lt: selection.before };
    let cursor = this.db
      .collection<CheckpointRow>(this.checkpoints)
      .find(query)
      .sort({ checkpoint_id: -1 });
    if (selection.limit != null) cursor = cursor.limit(selection.limit);
    for await (const row of cursor) yield decode(row, selection.owner);
  }
  async readWrites(
    key: CheckpointIdentity & { checkpointId: string },
  ): Promise<SerializedCheckpointWrite[]> {
    const legacy = key.owner != null && key.checkpointId === key.legacyCheckpointId;
    const rows = await this.db
      .collection<WriteRow>(this.writes)
      .find({
        checkpoint_id: key.checkpointId,
        $or: [
          physical(key),
          ...(legacy
            ? [
                {
                  thread_id: key.threadId,
                  checkpoint_ns: key.checkpointNs,
                  lc_owner: { $exists: false },
                },
              ]
            : []),
        ],
      })
      .toArray();
    const slots = new Map<string, WriteRow>();
    for (const row of rows) {
      const slot = JSON.stringify([row.task_id, row.idx]);
      if (!slots.has(slot) || row.checkpoint_ns === `${key.owner ?? ''}${key.checkpointNs}`)
        slots.set(slot, row);
    }
    return [...slots.values()].map((row) => ({
      taskId: row.task_id,
      index: row.idx,
      channel: row.channel,
      value: { type: row.type, bytes: row.value.value() },
    }));
  }
  async save(
    key: CheckpointIdentity,
    checkpoint: SerializedCheckpoint,
    context: { rootConversationId?: string; storageOwner?: string },
  ): Promise<void> {
    await this.recordStorage(key, context.storageOwner);
    await this.db.collection(this.checkpoints).updateOne(
      physical({ ...key, checkpointId: checkpoint.identity.checkpointId }),
      {
        $set: {
          ...(context.rootConversationId == null || key.threadId === context.rootConversationId
            ? {}
            : { lc_parent_thread: context.rootConversationId }),
          parent_checkpoint_id: checkpoint.parentCheckpointId,
          type: checkpoint.checkpoint.type,
          checkpoint: checkpoint.checkpoint.bytes,
          metadata: checkpoint.metadata.bytes,
          metadata_search: checkpoint.metadataSearch,
        },
        ...(this.timestamps ? { $currentDate: { upserted_at: true as const } } : {}),
      },
      { upsert: true },
    );
  }
  async saveWrites(
    key: CheckpointIdentity & { checkpointId: string },
    writes: readonly SerializedCheckpointWrite[],
    options: { replace: boolean; rootConversationId?: string; storageOwner?: string },
  ): Promise<void> {
    await this.recordStorage(key, options.storageOwner);
    const legacy = key.owner != null && key.checkpointId === key.legacyCheckpointId;
    const existing =
      !options.replace && legacy
        ? await this.db
            .collection<WriteRow>(this.writes)
            .find(
              {
                thread_id: key.threadId,
                checkpoint_ns: key.checkpointNs,
                checkpoint_id: key.checkpointId,
                task_id: writes[0]?.taskId,
                lc_owner: { $exists: false },
              },
              { projection: { idx: 1 } },
            )
            .toArray()
        : [];
    const legacySlots = new Set(existing.map((row) => row.idx));
    const operations = writes
      .filter((write) => !legacySlots.has(write.index))
      .map((write) => {
        const fields = {
          channel: write.channel,
          type: write.value.type,
          value: write.value.bytes,
          ...(key.owner == null ? {} : { lc_owner: key.owner }),
          ...(options.rootConversationId == null || key.threadId === options.rootConversationId
            ? {}
            : { lc_parent_thread: options.rootConversationId }),
        };
        return {
          updateOne: {
            filter: { ...physical(key), task_id: write.taskId, idx: write.index },
            update: options.replace
              ? {
                  $set: fields,
                  ...(this.timestamps ? { $currentDate: { upserted_at: true as const } } : {}),
                }
              : {
                  $setOnInsert: {
                    ...fields,
                    ...(this.timestamps ? { upserted_at: new Date() } : {}),
                  },
                },
            upsert: true,
          },
        };
      });
    if (operations.length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- Native collection; every operation carries its exact checkpoint ownership.
      await this.db.collection(this.writes).bulkWrite(operations);
    }
  }
  measureMetadata(metadata: Record<string, unknown>): number {
    return mongoose.mongo.BSON.calculateObjectSize(metadata);
  }
  async deleteThread(threadId: string): Promise<void> {
    if (typeof threadId !== 'string') throw new Error('Invalid threadId: expected a string');
    await this.db.collection(this.checkpoints).deleteMany({ thread_id: threadId });
    await this.db.collection(this.writes).deleteMany({ thread_id: threadId });
  }

  async captureGeneration(threadId: string, checkpointNamespace?: string): Promise<string[]> {
    const checkpoints = await this.db
      .collection<{ checkpoint_id?: string }>(this.checkpoints)
      .find(
        {
          thread_id: threadId,
          ...(checkpointNamespace != null
            ? { checkpoint_ns: generationNamespaceFilter(checkpointNamespace) }
            : legacyCheckpointStorageFilter()),
        },
        { projection: { _id: 0, checkpoint_id: 1 } },
      )
      .toArray();
    return checkpoints.reduce<string[]>((ids, checkpoint) => {
      if (typeof checkpoint.checkpoint_id === 'string') {
        ids.push(checkpoint.checkpoint_id);
      }
      return ids;
    }, []);
  }

  async deleteOwnedScope(threadId: string, checkpointNs: string, owner: string): Promise<void> {
    const filter = {
      thread_id: `${owner}${threadId}`,
      checkpoint_ns: generationNamespaceFilter(`${owner}${checkpointNs}`),
      lc_owner: owner,
    };
    await Promise.all([
      this.db.collection(this.checkpoints).deleteMany(filter),
      this.db.collection(this.writes).deleteMany(filter),
    ]);
  }

  async deleteOwned(
    userId: string,
    tenantId: string | undefined,
    conversationIds: readonly string[] | undefined,
  ): Promise<void> {
    const owner = checkpointOwnerNamespacePrefix(userId, tenantId);
    const ownership = { $or: [{ checkpoint_ns: { $regex: `^${owner}` } }, { lc_owner: owner }] };
    const ids = conversationIds == null ? undefined : [...new Set(conversationIds)];
    const batchSize = 128;
    for (let offset = 0; offset < (ids?.length ?? 1); offset += batchSize) {
      const filter = {
        ...ownership,
        ...(ids && {
          $and: [
            {
              $or: [
                {
                  thread_id: {
                    $in: ids
                      .slice(offset, offset + batchSize)
                      .flatMap((id) => [id, `${owner}${id}`]),
                  },
                },
                { lc_parent_thread: { $in: ids.slice(offset, offset + batchSize) } },
              ],
            },
          ],
        }),
      };
      await this.db.collection(this.checkpoints).deleteMany(filter);
      await this.db.collection(this.writes).deleteMany(filter);
    }
  }
  async deleteReference(reference: CheckpointReference, owner?: string): Promise<void> {
    const exact = {
      thread_id: reference.threadId,
      checkpoint_ns: reference.checkpointNs,
      checkpoint_id: reference.checkpointId,
      ...(owner == null
        ? { lc_owner: { $exists: false } }
        : { $or: [{ lc_owner: owner }, { lc_owner: { $exists: false } }] }),
    };
    await this.db.collection(this.writes).deleteMany(exact);
    await this.db.collection(this.checkpoints).deleteOne(exact);
  }
  async deleteReferences(
    references: readonly CheckpointReference[],
    owner?: string,
  ): Promise<void> {
    for (let offset = 0; offset < references.length; offset += 256) {
      const exact = {
        $and: [
          owner == null
            ? { lc_owner: { $exists: false } }
            : { $or: [{ lc_owner: owner }, { lc_owner: { $exists: false } }] },
          {
            $or: references.slice(offset, offset + 256).map((reference) => ({
              thread_id: reference.threadId,
              checkpoint_ns: reference.checkpointNs,
              checkpoint_id: reference.checkpointId,
            })),
          },
        ],
      };
      await this.db.collection(this.writes).deleteMany(exact);
      await this.db.collection(this.checkpoints).deleteMany(exact);
    }
  }
  async deleteGeneration(
    threadId: string,
    generation?: CheckpointGeneration,
    checkpointNamespace?: string,
  ): Promise<void> {
    if (generation && (generation.threadId !== threadId || generation.checkpointIds.length === 0))
      return;
    if (
      (generation &&
        Object.prototype.hasOwnProperty.call(generation, 'checkpointNamespace') &&
        !generation.checkpointNamespace) ||
      (!generation && checkpointNamespace === '')
    ) {
      throw new Error(
        'Legacy checkpoint cleanup requires a captured checkpoint generation, not an empty namespace',
      );
    }
    const namespace = generation ? generation.checkpointNamespace : checkpointNamespace;
    const filter = {
      thread_id: threadId,
      ...(namespace == null
        ? legacyCheckpointStorageFilter()
        : { checkpoint_ns: generationNamespaceFilter(namespace) }),
      ...(generation ? { checkpoint_id: { $in: generation.checkpointIds } } : {}),
    };
    await Promise.all([
      this.db.collection(this.checkpoints).deleteMany(filter),
      this.db.collection(this.writes).deleteMany(filter),
    ]);
  }
}
