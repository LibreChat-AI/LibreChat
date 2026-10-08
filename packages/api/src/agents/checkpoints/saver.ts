import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  CheckpointListOptions,
  CheckpointPendingWrite,
  PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Binary } from 'mongodb';
import type { Filter } from 'mongodb';

import type { CheckpointStorageRecord } from './storage';
import {
  CHECKPOINT_STORAGE_COLLECTION,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
  checkpointStorageKey,
} from './storage';

export const LIBRECHAT_CHECKPOINT_OWNER_KEY = '__librechat_checkpoint_owner';
export const LIBRECHAT_LEGACY_CHECKPOINT_KEY = '__librechat_legacy_checkpoint_id';

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  lc_owner?: string;
  type: string;
  checkpoint: Binary;
  metadata: Binary;
  metadata_search: CheckpointMetadata;
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

function ownerOf(config: RunnableConfig): string | undefined {
  const owner = config.configurable?.[LIBRECHAT_CHECKPOINT_OWNER_KEY];
  return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
}

function identity(config: RunnableConfig): {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id?: string;
} {
  const thread_id = config.configurable?.thread_id;
  const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';
  const checkpoint_id = config.configurable?.checkpoint_id;
  if (
    typeof thread_id !== 'string' ||
    typeof checkpoint_ns !== 'string' ||
    (checkpoint_id != null && typeof checkpoint_id !== 'string')
  ) {
    throw new Error('Invalid owned checkpoint identity');
  }
  return { thread_id, checkpoint_ns, ...(checkpoint_id == null ? {} : { checkpoint_id }) };
}

/** Isolate physical storage by owner while preserving logical SDK references. */
export class OwnedMongoSaver extends MongoDBSaver {
  private async recordStorage(config: RunnableConfig): Promise<void> {
    const namespace = config.configurable?.checkpoint_ns;
    const candidate =
      ownerOf(config) ??
      (typeof namespace === 'string' ? namespace.match(/^lcg:v2:[0-9a-f]{64}:/)?.[0] : undefined) ??
      config.configurable?.[LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY];
    if (typeof candidate !== 'string' || !/^lcg:v2:[0-9a-f]{64}:$/.test(candidate)) return;
    const storage = {
      type: 'mongo' as const,
      checkpointCollectionName: this.checkpointCollectionName,
      checkpointWritesCollectionName: this.checkpointWritesCollectionName,
    };
    await this.db
      .collection<CheckpointStorageRecord>(CHECKPOINT_STORAGE_COLLECTION)
      .updateOne(
        { _id: `${candidate}${checkpointStorageKey(storage)}` },
        { $setOnInsert: { owner: candidate, storage } },
        { upsert: true },
      );
  }

  private async tuple(doc: CheckpointRow, owner: string, legacy = false): Promise<CheckpointTuple> {
    const namespace = doc.checkpoint_ns.startsWith(owner)
      ? doc.checkpoint_ns.slice(owner.length)
      : doc.checkpoint_ns;
    const key = {
      thread_id: doc.thread_id.startsWith(owner)
        ? doc.thread_id.slice(owner.length)
        : doc.thread_id,
      checkpoint_ns: namespace,
      checkpoint_id: doc.checkpoint_id,
    };
    const rows = await this.db
      .collection<WriteRow>(this.checkpointWritesCollectionName)
      .find({
        checkpoint_id: key.checkpoint_id,
        $or: [
          {
            thread_id: `${owner}${key.thread_id}`,
            checkpoint_ns: `${owner}${namespace}`,
            lc_owner: owner,
          },
          ...(legacy
            ? [{ thread_id: key.thread_id, checkpoint_ns: namespace, lc_owner: { $exists: false } }]
            : []),
        ],
      })
      .toArray();
    const slots = new Map<string, WriteRow>();
    for (const row of rows) {
      const slot = JSON.stringify([row.task_id, row.idx]);
      if (!slots.has(slot) || row.checkpoint_ns === `${owner}${namespace}`) slots.set(slot, row);
    }
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      [...slots.values()].map(
        async (row) =>
          [
            row.task_id,
            row.channel,
            await this.serde.loadsTyped(row.type, row.value.value()),
          ] as CheckpointPendingWrite,
      ),
    );
    return {
      config: {
        configurable: {
          ...key,
          [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
          ...(legacy ? { [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: doc.checkpoint_id } : {}),
        },
      },
      checkpoint: (await this.serde.loadsTyped(doc.type, doc.checkpoint.value())) as Checkpoint,
      metadata: (await this.serde.loadsTyped(doc.type, doc.metadata.value())) as CheckpointMetadata,
      pendingWrites,
      ...(doc.parent_checkpoint_id == null
        ? {}
        : {
            parentConfig: {
              configurable: {
                ...key,
                checkpoint_id: doc.parent_checkpoint_id,
                [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
                [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: doc.parent_checkpoint_id,
              },
            },
          }),
    };
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const owner = ownerOf(config);
    if (owner == null) return super.getTuple(config);
    const key = identity(config);
    const checkpoints = this.db.collection<CheckpointRow>(this.checkpointCollectionName);
    let doc = await checkpoints
      .find({
        ...key,
        thread_id: `${owner}${key.thread_id}`,
        checkpoint_ns: `${owner}${key.checkpoint_ns}`,
        lc_owner: owner,
      })
      .sort({ checkpoint_id: -1 })
      .limit(1)
      .next();
    if (
      doc == null &&
      key.checkpoint_id != null &&
      key.checkpoint_id === config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY]
    ) {
      doc = await checkpoints.findOne({ ...key, lc_owner: { $exists: false } });
    }
    return doc == null
      ? undefined
      : this.tuple(
          doc,
          owner,
          key.checkpoint_id != null &&
            key.checkpoint_id === config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY],
        );
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const owner = ownerOf(config);
    if (owner == null) {
      yield* super.list(config, options);
      return;
    }
    const key = identity(config);
    const query: Filter<CheckpointRow> = {
      thread_id: `${owner}${key.thread_id}`,
      checkpoint_ns: `${owner}${key.checkpoint_ns}`,
      lc_owner: owner,
    };
    for (const [name, value] of Object.entries(options?.filter ?? {})) {
      if (value !== null && typeof value === 'object')
        throw new Error('Checkpoint metadata filters must be primitive');
      query[`metadata_search.${name}`] = value;
    }
    const before = options?.before?.configurable?.checkpoint_id;
    if (before != null) {
      if (typeof before !== 'string') throw new Error('Invalid checkpoint list boundary');
      query.checkpoint_id = { $lt: before };
    }
    let cursor = this.db
      .collection<CheckpointRow>(this.checkpointCollectionName)
      .find(query)
      .sort({ checkpoint_id: -1 });
    if (options?.limit != null) cursor = cursor.limit(options.limit);
    for await (const doc of cursor) yield await this.tuple(doc, owner);
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    await this.recordStorage(config);
    const owner = ownerOf(config);
    if (owner == null) return super.put(config, checkpoint, metadata);
    const key = identity(config);
    const [[type, serializedCheckpoint], [metadataType, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(checkpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type !== metadataType) throw new Error('Mismatched checkpoint and metadata types');
    const stored = {
      thread_id: key.thread_id,
      checkpoint_ns: key.checkpoint_ns,
      checkpoint_id: checkpoint.id,
    };
    await this.db.collection(this.checkpointCollectionName).updateOne(
      {
        ...stored,
        thread_id: `${owner}${key.thread_id}`,
        checkpoint_ns: `${owner}${key.checkpoint_ns}`,
        lc_owner: owner,
      },
      {
        $set: {
          parent_checkpoint_id: key.checkpoint_id,
          type,
          checkpoint: serializedCheckpoint,
          metadata: serializedMetadata,
          metadata_search: metadata,
        },
        ...(this.enableTimestamps ? { $currentDate: { upserted_at: true as const } } : {}),
      },
      { upsert: true },
    );
    return { configurable: { ...stored, [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner } };
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    await this.recordStorage(config);
    const owner = ownerOf(config);
    if (owner == null) return super.putWrites(config, writes, taskId);
    const key = identity(config);
    if (key.checkpoint_id == null) throw new Error('Owned writes require a checkpoint id');
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const legacy = key.checkpoint_id === config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY];
    const existing =
      !allSpecial && legacy
        ? await this.db
            .collection<WriteRow>(this.checkpointWritesCollectionName)
            .find(
              { ...key, task_id: taskId, lc_owner: { $exists: false } },
              { projection: { idx: 1 } },
            )
            .toArray()
        : [];
    const legacySlots = new Set(existing.map((row) => row.idx));
    const operations = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        if (legacySlots.has(WRITES_IDX_MAP[channel] ?? idx)) return null;
        const [type, serializedValue] = await this.serde.dumpsTyped(value);
        const fields = { channel, type, value: serializedValue, lc_owner: owner };
        return {
          updateOne: {
            filter: {
              ...key,
              thread_id: `${owner}${key.thread_id}`,
              checkpoint_ns: `${owner}${key.checkpoint_ns}`,
              task_id: taskId,
              idx: WRITES_IDX_MAP[channel] ?? idx,
              lc_owner: owner,
            },
            update: allSpecial
              ? {
                  $set: fields,
                  ...(this.enableTimestamps
                    ? { $currentDate: { upserted_at: true as const } }
                    : {}),
                }
              : {
                  $setOnInsert: {
                    ...fields,
                    ...(this.enableTimestamps ? { upserted_at: new Date() } : {}),
                  },
                },
            upsert: true,
          },
        };
      }),
    );
    const pending = operations.filter((operation) => operation != null);
    if (pending.length > 0)
      await this.db.collection(this.checkpointWritesCollectionName).bulkWrite(pending);
  }
}
