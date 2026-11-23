import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Document, IndexDescriptionInfo, ObjectId } from 'mongodb';
import type { Connection } from 'mongoose';
import { buildIndexWithRetry } from '~/utils/retry';

interface Definition {
  collection: string;
  keys: Record<string, 1>;
  ignored: readonly string[];
}

const DEFINITIONS: readonly Definition[] = [
  {
    collection: 'systemgrants',
    keys: { principalType: 1, principalId: 1, capability: 1, tenantId: 1 },
    ignored: ['grantedAt', 'grantedBy'],
  },
  { collection: 'roles', keys: { name: 1, tenantId: 1 }, ignored: [] },
  { collection: 'agentcategories', keys: { value: 1, tenantId: 1 }, ignored: [] },
];
const ARCHIVE = 'authorization_duplicate_archive';
interface ArchivedDuplicate {
  _id: { collection: string; sourceId: ObjectId };
  original: Document;
  survivorId: ObjectId;
  archivedAt: Date;
}

interface CollectionReport {
  collection: string;
  duplicateGroups: number;
  excessDocuments: number;
  conflictingGroups: number;
  removedDocuments: number;
  uniqueIndex: boolean;
}

export interface AuthorizationRepairOptions {
  dryRun?: boolean;
  /** Operator acknowledgement, not an application fence. Includes seeders and background writers. */
  writersPaused?: boolean;
  /** Maintenance-only scan bounds; not request-path configuration. */
  maxTimeMS?: number;
  maxGroupSize?: number;
}

function content(document: Document, ignored: readonly string[]): Document {
  return Object.fromEntries(
    Object.entries(document).filter(
      ([key]) => !['_id', '__v', 'createdAt', 'updatedAt', ...ignored].includes(key),
    ),
  );
}

function sameIndex(index: IndexDescriptionInfo, keys: Definition['keys']): boolean {
  return (
    isDeepStrictEqual(Object.entries(index.key), Object.entries(keys)) &&
    index.unique === true &&
    !index.sparse &&
    !index.partialFilterExpression &&
    !index.collation
  );
}

/**
 * Explicit, resumable maintenance for three small authorization/configuration collections.
 * Uses native collections to cover every tenant without compiling models or triggering seeders.
 * Never merges conflicting settings, rewrites survivors, drops indexes, or prints identities.
 * All affected writers must be gated and drained throughout apply; unrelated chat writes may continue.
 */
export async function repairAuthorizationDuplicates(
  connection: Connection,
  {
    dryRun = true,
    writersPaused = false,
    maxTimeMS = 60_000,
    maxGroupSize = 1_000,
  }: AuthorizationRepairOptions = {},
): Promise<CollectionReport[]> {
  if (!dryRun && !writersPaused) {
    throw new Error('Authorization repair requires paused and drained collection writers');
  }
  if (
    !Number.isSafeInteger(maxTimeMS) ||
    maxTimeMS <= 0 ||
    !Number.isSafeInteger(maxGroupSize) ||
    maxGroupSize < 2
  ) {
    throw new Error('Invalid authorization repair scan bounds');
  }
  const db = connection.db;
  if (!db) {
    throw new Error('Authorization repair requires an open database connection');
  }

  async function indexes(definition: Definition): Promise<IndexDescriptionInfo[]> {
    try {
      return await db!
        .collection(definition.collection, { readPreference: 'primary' })
        .listIndexes({ maxTimeMS })
        .toArray();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 26) {
        return [];
      }
      throw error;
    }
  }

  async function scan(
    definition: Definition,
    report: CollectionReport,
    apply: boolean,
  ): Promise<void> {
    const collection = db!.collection(definition.collection, { readPreference: 'primary' });
    const archive = db!.collection<ArchivedDuplicate>(ARCHIVE, { readPreference: 'primary' });
    const identity = Object.fromEntries(
      Object.keys(definition.keys).map((key) => [key, { $ifNull: [`$${key}`, null] }]),
    );
    const cursor = collection.aggregate<{ _id: Document; count: number }>(
      [{ $group: { _id: identity, count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }],
      { allowDiskUse: false, maxTimeMS, batchSize: 50 },
    );
    try {
      for await (const group of cursor) {
        report.duplicateGroups++;
        report.excessDocuments += group.count - 1;
        if (group.count > maxGroupSize) {
          throw new Error('Authorization duplicate group exceeds the configured bound');
        }
        // Null matches both absent and explicit-null fields, as the unique index does.
        const records = await collection
          .find(
            Object.fromEntries(
              Object.entries(group._id).map(([key, value]) => [key, { $eq: value }]),
            ),
            { maxTimeMS },
          )
          .sort({ _id: 1 })
          .limit(maxGroupSize + 1)
          .toArray();
        if (records.length !== group.count) {
          throw new Error('Authorization data changed during repair; verify the write gate');
        }
        const [survivor, ...duplicates] = records;
        const settings = content(survivor, definition.ignored);
        if (
          duplicates.some(
            (record) => !isDeepStrictEqual(content(record, definition.ignored), settings),
          )
        ) {
          report.conflictingGroups++;
          continue;
        }
        if (!apply) {
          continue;
        }
        for (const record of duplicates) {
          // Preserve complete provenance before deletion. The archive has no TTL and is not read by auth.
          const archiveId = { collection: definition.collection, sourceId: record._id };
          await archive.updateOne(
            { _id: archiveId },
            {
              $setOnInsert: { original: record, survivorId: survivor._id, archivedAt: new Date() },
            },
            { upsert: true, writeConcern: { w: 'majority' } },
          );
          const archived = await archive.findOne({ _id: archiveId }, { maxTimeMS });
          if (!archived || !isDeepStrictEqual(archived.original, record)) {
            throw new Error('Authorization archive differs from source; refusing deletion');
          }
          const removed = await collection.deleteOne(
            { _id: record._id },
            { writeConcern: { w: 'majority' } },
          );
          if (removed.deletedCount !== 1) {
            throw new Error('Authorization data changed during repair; verify the write gate');
          }
          report.removedDocuments++;
        }
      }
    } finally {
      await cursor.close();
    }
  }

  const locks = db.collection<{ _id: string; owner: string }>('authorization_repair_locks');
  const owner = randomUUID();
  if (!dryRun) {
    // No expiry: a slow index build must never allow a second migrator to take over.
    await locks.insertOne({ _id: 'authorization', owner }, { writeConcern: { w: 'majority' } });
  }
  try {
    const reports: CollectionReport[] = [];
    // Inspect every collection before deleting anything, so known conflicts fail without partial cleanup.
    for (const definition of DEFINITIONS) {
      const current = await indexes(definition);
      const name = Object.keys(definition.keys)
        .map((key) => `${key}_1`)
        .join('_');
      if (current.some((index) => index.name === name && !sameIndex(index, definition.keys))) {
        throw new Error(`Unexpected ${definition.collection} constraint; inspect before repair`);
      }
      const report: CollectionReport = {
        collection: definition.collection,
        duplicateGroups: 0,
        excessDocuments: 0,
        conflictingGroups: 0,
        removedDocuments: 0,
        uniqueIndex: current.some((index) => sameIndex(index, definition.keys)),
      };
      await scan(definition, report, false);
      reports.push(report);
    }
    if (dryRun) {
      return reports;
    }
    if (reports.some((report) => report.conflictingGroups > 0)) {
      throw new Error('Conflicting authorization settings; inspect dry-run counts before repair');
    }

    for (const [i, definition] of DEFINITIONS.entries()) {
      const report = reports[i];
      const applied = { ...report, duplicateGroups: 0, excessDocuments: 0, conflictingGroups: 0 };
      await scan(definition, applied, true);
      report.removedDocuments = applied.removedDocuments;
      if (applied.conflictingGroups > 0) {
        throw new Error('Authorization settings changed after preflight; verify the write gate');
      }
      if (!report.uniqueIndex) {
        await buildIndexWithRetry(async () => {
          try {
            return await db
              .collection(definition.collection)
              .createIndex(definition.keys, { unique: true, background: true });
          } catch (error) {
            // The shared retry helper logs errors; never give it a duplicate-key identity or raw query.
            const code = error instanceof Error && 'code' in error ? error.code : undefined;
            throw Object.assign(new Error('Authorization index build failed'), { code });
          }
        }, `createIndex(${definition.collection})`);
      }
      if (!(await indexes(definition)).some((index) => sameIndex(index, definition.keys))) {
        throw new Error('Authorization unique constraint could not be verified');
      }
      report.uniqueIndex = true;
    }
    return reports;
  } finally {
    if (!dryRun) {
      await locks.deleteOne({ _id: 'authorization', owner }, { writeConcern: { w: 'majority' } });
    }
  }
}
