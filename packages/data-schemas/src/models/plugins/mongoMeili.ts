import _ from 'lodash';
import { parseTextParts } from 'librechat-data-provider';
import { MeiliSearch, MeiliSearchTimeOutError } from 'meilisearch';
import type {
  CallbackWithoutResultAndOptionalError,
  FilterQuery,
  Document,
  Schema,
  Query,
  Types,
  Model,
} from 'mongoose';
import type { SearchResponse, SearchParams, Index, MeiliSearchErrorInfo } from 'meilisearch';
import type { IConversation, IMessage } from '~/types';
import { buildRetentionVisibilityFilter, legacyPermanentExpirationFilter } from '~/utils/retention';
import logger from '~/config/meiliLogger';

/** Internal per-query bypass for writes to non-searchable bookkeeping fields. A WeakSet keeps
 * this marker out of driver options and stored data. Other model middleware still runs. */
const queriesWithoutMeiliIndexing = new WeakSet<object>();
export function withoutMeiliIndexing<T extends object>(query: T): T {
  queriesWithoutMeiliIndexing.add(query);
  return query;
}

interface MongoMeiliOptions {
  host: string;
  apiKey: string;
  indexName: string;
  primaryKey: string;
  mongoose: typeof import('mongoose');
  syncBatchSize?: number;
  syncDelayMs?: number;
  /** Documents carrying this path remain in MongoDB but are excluded from search. */
  excludeFromIndexPath?: string;
}

interface MeiliIndexable {
  [key: string]: unknown;
  _meiliIndex?: boolean;
  _meiliIndexAttempted?: boolean;
  _meiliIndexVersion?: string;
  _meiliIndexSchemaVersion?: number;
  _meiliCleanupVersion?: number;
}

interface SyncProgress {
  lastSyncedId?: string;
  totalProcessed: number;
  totalDocuments: number;
  pendingIndexing: number;
  pendingCleanup: number;
  isComplete: boolean;
}

interface _DocumentWithMeiliIndex extends Document {
  _meiliIndex?: boolean;
  _meiliIndexAttempted?: boolean;
  _meiliIndexVersion?: string;
  _meiliIndexSchemaVersion?: number;
  _meiliCleanupVersion?: number;
  isTemporary?: boolean;
  expiredAt?: Date | null;
  preprocessObjectForIndex?: () => Record<string, unknown>;
  addObjectToMeili?: (next: CallbackWithoutResultAndOptionalError) => Promise<void>;
  updateObjectToMeili?: (next: CallbackWithoutResultAndOptionalError) => Promise<void>;
  deleteObjectFromMeili?: (next: CallbackWithoutResultAndOptionalError) => Promise<void>;
  postSaveHook?: (next: CallbackWithoutResultAndOptionalError) => Promise<void>;
  postUpdateHook?: (next: CallbackWithoutResultAndOptionalError) => Promise<void> | void;
  postRemoveHook?: (next: CallbackWithoutResultAndOptionalError) => Promise<void> | void;
}

export type DocumentWithMeiliIndex = _DocumentWithMeiliIndex & IConversation & Partial<IMessage>;

export interface SchemaWithMeiliMethods extends Model<DocumentWithMeiliIndex> {
  syncWithMeili(): Promise<void>;
  getSyncProgress(): Promise<SyncProgress>;
  processSyncBatch(
    index: Index<MeiliIndexable>,
    documents: Array<Record<string, unknown>>,
  ): Promise<void>;
  cleanupExcludedMeiliIndex(): Promise<void>;
  cleanupMeiliIndex(
    index: Index<MeiliIndexable>,
    primaryKey: string,
    batchSize: number,
    delayMs: number,
  ): Promise<void>;
  setMeiliIndexSettings(settings: Record<string, unknown>): Promise<unknown>;
  meiliSearch(
    q: string,
    params?: SearchParams,
    populate?: boolean,
  ): Promise<SearchResponse<MeiliIndexable, Record<string, unknown>>>;
}

// Environment flags
/**
 * Flag to indicate if search is enabled based on environment variables.
 */
const searchEnabled = process.env.SEARCH != null && process.env.SEARCH.toLowerCase() === 'true';

/**
 * Flag to indicate if MeiliSearch is enabled based on required environment variables.
 */
const meiliEnabled =
  process.env.MEILI_HOST != null && process.env.MEILI_MASTER_KEY != null && searchEnabled;

/**
 * Get sync configuration from environment variables
 */
const getSyncConfig = () => ({
  batchSize: parseInt(process.env.MEILI_SYNC_BATCH_SIZE || '100', 10),
  delayMs: parseInt(process.env.MEILI_SYNC_DELAY_MS || '100', 10),
});

const hasSchemaPath = (schema: Schema, path: string): boolean =>
  Object.prototype.hasOwnProperty.call(schema.obj, path);

/** Bump when the indexed document shape or projection changes. */
export const MEILI_INDEX_SCHEMA_VERSION = 1;

const explicitTemporaryFlagKey = 'meiliExplicitTemporaryFlag';
const previouslyIndexedFlagKey = 'meiliPreviouslyIndexed';
const meiliCleanupVersion = 1;
const meiliRequestTimeoutMs = 10_000;
const meiliWriteMaxAttempts = 3;
const meiliRetryBaseDelayMs = 250;
const meiliVersionReconcileMaxAttempts = 3;
const completeDetachedOperation: CallbackWithoutResultAndOptionalError = () => undefined;

const retryDetachedMeiliWrite = async (
  operation: () => Promise<unknown>,
  context: string,
): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < meiliWriteMaxAttempts; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < meiliWriteMaxAttempts) {
        logger.warn(`${context} Retrying detached Meili write`, error);
        await new Promise((resolve) =>
          setTimeout(resolve, meiliRetryBaseDelayMs * Math.pow(2, attempt)),
        );
      }
    }
  }
  throw lastError;
};

const createDetachedMeiliRunner = () => {
  const pendingOperations = new Map<string, Promise<void>>();

  return (key: string, operation: () => Promise<void> | void, context: string): void => {
    const previousOperation = pendingOperations.get(key) ?? Promise.resolve();
    const operationPromise = previousOperation.then(operation).catch((error) => {
      logger.error(context, error);
    });
    const trackedOperation = operationPromise.finally(() => {
      if (pendingOperations.get(key) === trackedOperation) {
        pendingOperations.delete(key);
      }
    });

    pendingOperations.set(key, trackedOperation);
  };
};

const buildRetentionIndexableQuery = (schema: Schema): FilterQuery<unknown> => {
  if (hasSchemaPath(schema, 'isTemporary')) {
    return buildRetentionVisibilityFilter();
  }
  if (hasSchemaPath(schema, 'expiredAt')) {
    return legacyPermanentExpirationFilter();
  }
  return {};
};

const buildIndexableQuery = (
  schema: Schema,
  excludeFromIndexPath?: string,
): FilterQuery<unknown> => {
  const retentionFilter = buildRetentionIndexableQuery(schema);

  if (excludeFromIndexPath == null) {
    return retentionFilter;
  }

  return {
    $and: [retentionFilter, { [excludeFromIndexPath]: { $exists: false } }],
  };
};

/**
 * Excluded documents that may still hold a Meili entry. The legacy branch matches a
 * `_meiliCleanupVersion` that is absent or null, written as a null equality rather than
 * `$exists: false` so `meili_excluded_legacy_cleanup_v4` can serve it: a partial index
 * accepts null equality and rejects `$exists: false`, and the planner only reaches a
 * partial index through a predicate that implies its filter.
 */
export const buildExcludedIndexedQuery = (
  excludeFromIndexPath?: string,
): FilterQuery<unknown> | null => {
  if (excludeFromIndexPath == null) {
    return null;
  }

  return {
    [excludeFromIndexPath]: { $exists: true },
    $or: [
      { _meiliIndex: true },
      { _meiliIndexAttempted: true },
      { _meiliIndex: false, _meiliCleanupVersion: null },
    ],
  };
};

const isExcludedFromIndex = (doc: DocumentWithMeiliIndex, excludeFromIndexPath?: string): boolean =>
  excludeFromIndexPath != null && !_.isNil(_.get(doc, excludeFromIndexPath));

const hasActiveExpiration = (expiredAt?: Date | null): boolean =>
  _.isNil(expiredAt) || new Date(expiredAt).getTime() > Date.now();

/**
 * `isTemporary` defaults to `false` on the schema, so hydrated legacy documents
 * can appear non-temporary even when the field is absent from MongoDB. `$isDefault`
 * lets us distinguish that schema default from an explicit stored flag, and
 * `$locals` carries the pre-save answer into post hooks after Mongoose mutates
 * document state.
 */
const hasExplicitTemporaryFlag = (doc: DocumentWithMeiliIndex): boolean =>
  typeof doc.$locals?.[explicitTemporaryFlagKey] === 'boolean'
    ? (doc.$locals[explicitTemporaryFlagKey] as boolean)
    : doc.isTemporary != null && !doc.$isDefault('isTemporary');

const captureExplicitTemporaryFlag = (doc: DocumentWithMeiliIndex): void => {
  doc.$locals[explicitTemporaryFlagKey] = doc.isTemporary != null && !doc.$isDefault('isTemporary');
};

/**
 * Index only retained non-temporary records whose flag was explicitly stored,
 * plus legacy permanent records that have no retention deadline. Legacy records
 * with an expiration are treated as temporary and stay out of search.
 */
const isIndexableDocument = (doc: DocumentWithMeiliIndex, excludeFromIndexPath?: string): boolean =>
  !isExcludedFromIndex(doc, excludeFromIndexPath) &&
  ((doc.isTemporary === false &&
    hasExplicitTemporaryFlag(doc) &&
    hasActiveExpiration(doc.expiredAt)) ||
    (!hasExplicitTemporaryFlag(doc) && _.isNil(doc.expiredAt)));

/**
 * Validates the required options for configuring the mongoMeili plugin.
 */
const validateOptions = (options: Partial<MongoMeiliOptions>): void => {
  const requiredKeys: (keyof MongoMeiliOptions)[] = ['host', 'apiKey', 'indexName', 'primaryKey'];
  requiredKeys.forEach((key) => {
    if (!options[key]) {
      throw new Error(`Missing mongoMeili Option: ${key}`);
    }
  });
};

/**
 * Helper function to process documents in batches with rate limiting
 */
const processBatch = async <T>(
  items: T[],
  batchSize: number,
  delayMs: number,
  processor: (batch: T[]) => Promise<void>,
): Promise<void> => {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await processor(batch);

    // Add delay between batches to prevent overwhelming resources
    if (i + batchSize < items.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

/**
 * Factory function to create a MeiliMongooseModel class which extends a Mongoose model.
 * This class contains static and instance methods to synchronize and manage the MeiliSearch index
 * corresponding to the MongoDB collection.
 *
 * @param config - Configuration object.
 * @param config.index - The MeiliSearch index object.
 * @param config.attributesToIndex - List of attributes to index.
 * @param config.primaryKey - The primary key field for MeiliSearch document operations.
 * @param config.syncOptions - Sync configuration options.
 * @returns A class definition that will be loaded into the Mongoose schema.
 */
const createMeiliMongooseModel = ({
  client,
  index,
  getIndexableQuery,
  getExcludedIndexedQuery,
  excludeFromIndexPath,
  attributesToIndex,
  primaryKey,
  syncOptions,
}: {
  client: MeiliSearch;
  index: Index<MeiliIndexable>;
  getIndexableQuery: () => FilterQuery<unknown>;
  getExcludedIndexedQuery: () => FilterQuery<unknown> | null;
  excludeFromIndexPath?: string;
  attributesToIndex: string[];
  primaryKey: string;
  syncOptions: { batchSize: number; delayMs: number };
}) => {
  const syncConfig = { ...getSyncConfig(), ...syncOptions };

  const loadLatestDocument = async (
    doc: DocumentWithMeiliIndex,
  ): Promise<DocumentWithMeiliIndex | null> => {
    const model = doc.constructor as Model<DocumentWithMeiliIndex>;
    const selection = [
      ...attributesToIndex,
      '+_meiliIndex',
      '+_meiliIndexAttempted',
      '+_meiliIndexVersion',
      '+_meiliIndexSchemaVersion',
      'isTemporary',
      'expiredAt',
      'unfinished',
      ...(excludeFromIndexPath == null ? [] : [`+${excludeFromIndexPath}`]),
    ].join(' ');
    return await model.findById(doc._id).select(selection).exec();
  };

  const deleteDocumentAndWait = async (doc: DocumentWithMeiliIndex): Promise<void> => {
    const deletion = await index.deleteDocument(
      String(doc[primaryKey as keyof DocumentWithMeiliIndex]),
    );
    const deletionTask = await client.waitForTask(deletion.taskUid, {
      timeOutMs: meiliRequestTimeoutMs,
      intervalMs: 100,
    });
    if (deletionTask.status !== 'succeeded') {
      throw new Error(`Meili cleanup task ${deletion.taskUid} ended with ${deletionTask.status}`);
    }
  };

  /**
   * Submit a versioned snapshot and acknowledge only the MongoDB write that
   * produced it. If another replica wins the race, enqueue the latest snapshot
   * after the stale Meili task so task ordering converges on current Mongo data.
   */
  const syncVersionedDocument = async (
    initialDoc: DocumentWithMeiliIndex,
    initialMode: 'add' | 'update',
  ): Promise<void> => {
    let doc = initialDoc;
    let mode = initialMode;

    for (let attempt = 0; attempt < meiliVersionReconcileMaxAttempts; attempt++) {
      const version = doc._meiliIndexVersion;
      if (!version) {
        throw new Error('Missing _meiliIndexVersion for detached Meili write');
      }

      if (!isIndexableDocument(doc, excludeFromIndexPath) || doc.unfinished) {
        await retryDetachedMeiliWrite(
          () => deleteDocumentAndWait(doc),
          '[mongoMeili] Failed to remove a non-indexable document.',
        );
        // eslint-disable-next-line no-restricted-syntax -- versioned internal bookkeeping must not re-enter document middleware
        const cleanup = await doc.collection.updateOne(
          { _id: doc._id as Types.ObjectId, _meiliIndexVersion: version },
          {
            $set: { _meiliCleanupVersion: meiliCleanupVersion },
            $unset: { _meiliIndex: '', _meiliIndexAttempted: '' },
          },
        );
        if (cleanup.matchedCount > 0) {
          return;
        }
      } else {
        const object = doc.preprocessObjectForIndex!();
        await retryDetachedMeiliWrite(async () => {
          const enqueued =
            mode === 'update'
              ? index.updateDocuments([object], { primaryKey })
              : index.addDocuments([object], { primaryKey });
          const task = await enqueued;
          const completedTask = await client.waitForTask(task.taskUid, {
            timeOutMs: meiliRequestTimeoutMs,
            intervalMs: 100,
          });
          if (completedTask.status !== 'succeeded') {
            throw new Error(`Meili write task ${task.taskUid} ended with ${completedTask.status}`);
          }
        }, '[mongoMeili] Failed to submit a document to Meili.');
        // eslint-disable-next-line no-restricted-syntax -- versioned internal bookkeeping must not re-enter document middleware
        const acknowledgement = await doc.collection.updateOne(
          { _id: doc._id as Types.ObjectId, _meiliIndexVersion: version },
          {
            $set: {
              _meiliIndex: true,
              _meiliCleanupVersion: meiliCleanupVersion,
              _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION,
            },
          },
        );
        if (acknowledgement.matchedCount > 0) {
          return;
        }
      }

      const latestDoc = await loadLatestDocument(doc);
      if (!latestDoc) {
        await retryDetachedMeiliWrite(
          () => deleteDocumentAndWait(doc),
          '[mongoMeili] Failed to remove a concurrently deleted document.',
        );
        return;
      }
      doc = latestDoc;
      mode = 'add';
    }

    // eslint-disable-next-line no-restricted-syntax -- versioned internal bookkeeping must not re-enter document middleware
    await doc.collection.updateOne(
      { _id: doc._id as Types.ObjectId, _meiliIndexVersion: doc._meiliIndexVersion },
      { $set: { _meiliIndex: false, _meiliIndexAttempted: true } },
    );
    throw new Error('Meili indexing did not converge after concurrent MongoDB writes');
  };

  class MeiliMongooseModel {
    /**
     * Get the current sync progress
     */
    static async getSyncProgress(this: SchemaWithMeiliMethods): Promise<SyncProgress> {
      const indexableQuery = getIndexableQuery();
      const excludedIndexedQuery = getExcludedIndexedQuery();
      const needsIndexingQuery: FilterQuery<unknown> = {
        $and: [
          indexableQuery,
          {
            $or: [
              { _meiliIndex: { $ne: true }, _meiliIndexAttempted: true },
              {
                _meiliIndex: true,
                _meiliIndexSchemaVersion: { $ne: MEILI_INDEX_SCHEMA_VERSION },
              },
            ],
          },
        ],
      };
      const [totalDocuments, totalProcessed, pendingIndexing, pendingCleanup] = await Promise.all([
        this.countDocuments(indexableQuery),
        this.countDocuments({
          $and: [
            indexableQuery,
            {
              _meiliIndex: true,
              _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION,
            },
          ],
        }),
        this.countDocuments(needsIndexingQuery),
        excludedIndexedQuery == null
          ? Promise.resolve(0)
          : this.countDocuments(excludedIndexedQuery),
      ]);

      return {
        totalProcessed,
        totalDocuments,
        pendingIndexing,
        pendingCleanup,
        isComplete: totalProcessed === totalDocuments && pendingCleanup === 0,
      };
    }

    /**
     * Synchronizes data between the MongoDB collection and the MeiliSearch index by
     * incrementally indexing only non-temporary documents that are unindexed or stale.
     * */
    static async syncWithMeili(this: SchemaWithMeiliMethods): Promise<void> {
      const startTime = Date.now();
      const { batchSize, delayMs } = syncConfig;

      const collectionName = primaryKey === 'messageId' ? 'messages' : 'conversations';
      logger.info(
        `[syncWithMeili] Starting sync for ${collectionName} with batch size ${batchSize}`,
      );

      // Get approximate total count for raw estimation, the sync should not overcome this number
      // eslint-disable-next-line no-restricted-syntax -- a collection-wide estimate is the quantity wanted here: it bounds a full-index sync and only feeds a progress log, so a tenant-scoped count would be wrong, not just unnecessary.
      const approxTotalCount = await this.estimatedDocumentCount();
      logger.info(
        `[syncWithMeili] Approximate total number of all ${collectionName}: ${approxTotalCount}`,
      );

      try {
        // First, handle documents that need to be removed from Meili
        logger.info(`[syncWithMeili] Starting cleanup of Meili index ${index.uid} before sync`);
        await this.cleanupMeiliIndex(index, primaryKey, batchSize, delayMs);
        logger.info(`[syncWithMeili] Completed cleanup of Meili index: ${index.uid}`);
      } catch (error) {
        logger.error('[syncWithMeili] Error during cleanup Meili before sync:', error);
        throw error;
      }

      let processedCount = 0;
      let hasMore = true;

      while (hasMore) {
        const indexableQuery = getIndexableQuery();
        const query: FilterQuery<unknown> = {
          $and: [
            indexableQuery,
            {
              $or: [
                { _meiliIndex: { $ne: true } },
                {
                  _meiliIndex: true,
                  _meiliIndexSchemaVersion: { $ne: MEILI_INDEX_SCHEMA_VERSION },
                },
              ],
            },
          ],
        };

        try {
          const documents = await this.find(query)
            .select(attributesToIndex.join(' ') + ' _meiliIndex')
            .limit(batchSize)
            .lean();

          // Check if there are more documents to process
          if (documents.length === 0) {
            logger.info('[syncWithMeili] No more documents to process');
            break;
          }

          // Process the batch
          await this.processSyncBatch(index, documents);
          processedCount += documents.length;
          logger.info(`[syncWithMeili] Processed: ${processedCount}`);

          if (documents.length < batchSize) {
            hasMore = false;
          }

          // Add delay to prevent overwhelming resources
          if (hasMore && delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        } catch (error) {
          logger.error('[syncWithMeili] Error processing documents batch:', error);
          throw error;
        }
      }

      const duration = Date.now() - startTime;
      logger.info(
        `[syncWithMeili] Completed sync for ${collectionName}. Processed ${processedCount} documents in ${duration}ms`,
      );
    }

    /**
     * Process a batch of documents for syncing
     */
    static async processSyncBatch(
      this: SchemaWithMeiliMethods,
      index: Index<MeiliIndexable>,
      documents: Array<Record<string, unknown>>,
    ): Promise<void> {
      if (documents.length === 0) {
        return;
      }

      // Format documents for MeiliSearch
      const formattedDocs = documents.map((doc) =>
        _.omitBy(_.pick(doc, attributesToIndex), (_v, k) => k.startsWith('$')),
      );

      try {
        const docsIds = documents.map((doc) => doc._id);
        await this.updateMany(
          { _id: { $in: docsIds } },
          { $set: { _meiliIndexAttempted: true } },
          { timestamps: false },
        );

        // Add documents to MeiliSearch
        await index.addDocumentsInBatches(formattedDocs, undefined, { primaryKey });

        // Update MongoDB to mark documents as indexed.
        // { timestamps: false } prevents Mongoose from touching updatedAt, preserving
        // original conversation/message timestamps (fixes sidebar chronological sort).
        await this.updateMany(
          { _id: { $in: docsIds } },
          {
            $set: {
              _meiliIndex: true,
              _meiliCleanupVersion: meiliCleanupVersion,
              _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION,
            },
          },
          { timestamps: false },
        );
      } catch (error) {
        logger.error('[processSyncBatch] Error processing batch:', error);
        throw error;
      }
    }

    /**
     * Remove documents that are intentionally excluded from search without
     * scanning the complete Meili index. The Mongo marker is cleared only
     * after Meili confirms deletion, so interrupted cleanup is retried.
     */
    static async cleanupExcludedMeiliIndex(this: SchemaWithMeiliMethods): Promise<void> {
      const excludedIndexedQuery = getExcludedIndexedQuery();
      if (excludedIndexedQuery == null) {
        return;
      }

      const { batchSize, delayMs } = syncConfig;
      while (true) {
        const pendingExcludedDocuments = await this.find(excludedIndexedQuery)
          .select(primaryKey)
          .limit(batchSize)
          .lean();
        if (pendingExcludedDocuments.length === 0) {
          break;
        }

        const pendingIds = pendingExcludedDocuments.map(
          (doc: Record<string, unknown>) => doc[primaryKey],
        );
        const deletion = await index.deleteDocuments(pendingIds.map(String));
        const deletionTask = await client.waitForTask(deletion.taskUid, {
          timeOutMs: 10000,
          intervalMs: 100,
        });
        if (deletionTask.status !== 'succeeded') {
          throw new Error(
            `Meili cleanup task ${deletion.taskUid} ended with ${deletionTask.status}`,
          );
        }
        await this.updateMany(
          { ...excludedIndexedQuery, [primaryKey]: { $in: pendingIds } },
          {
            $set: { _meiliCleanupVersion: meiliCleanupVersion },
            $unset: { _meiliIndex: '', _meiliIndexAttempted: '' },
          },
          { timestamps: false },
        );

        if (pendingExcludedDocuments.length < batchSize) {
          break;
        }
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    /**
     * Clean up documents in MeiliSearch that no longer exist in MongoDB
     */
    static async cleanupMeiliIndex(
      this: SchemaWithMeiliMethods,
      index: Index<MeiliIndexable>,
      primaryKey: string,
      batchSize: number,
      delayMs: number,
    ): Promise<void> {
      try {
        await this.cleanupExcludedMeiliIndex();

        let offset = 0;
        let moreDocuments = true;

        while (moreDocuments) {
          const batch = await index.getDocuments({ limit: batchSize, offset });
          if (batch.results.length === 0) {
            moreDocuments = false;
            break;
          }

          const meiliIds = batch.results.map((doc) => doc[primaryKey]);
          const query: Record<string, unknown> = {};
          query[primaryKey] = { $in: meiliIds };

          const existingDocs = await this.find({ ...query, ...getIndexableQuery() })
            .select(primaryKey)
            .lean();

          const existingIds = new Set(
            existingDocs.map((doc: Record<string, unknown>) => doc[primaryKey]),
          );

          // Delete documents that don't exist in MongoDB
          const toDelete = meiliIds.filter((id) => !existingIds.has(id));
          if (toDelete.length > 0) {
            const deletion = await index.deleteDocuments(toDelete.map(String));
            const deletionTask = await client.waitForTask(deletion.taskUid, {
              timeOutMs: 10000,
              intervalMs: 100,
            });
            if (deletionTask.status !== 'succeeded') {
              throw new Error(
                `Meili cleanup task ${deletion.taskUid} ended with ${deletionTask.status}`,
              );
            }
            await this.updateMany(
              { [primaryKey]: { $in: toDelete } },
              {
                $set: { _meiliCleanupVersion: meiliCleanupVersion },
                $unset: { _meiliIndex: '', _meiliIndexAttempted: '' },
              },
              { timestamps: false },
            );
            logger.debug(`[cleanupMeiliIndex] Deleted ${toDelete.length} orphaned documents`);
          }
          // if fetch documents request returns less documents than limit, all documents are processed
          if (batch.results.length < batchSize) {
            break;
          }

          offset += batchSize - toDelete.length;

          // Add delay between batches
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      } catch (error) {
        logger.error('[cleanupMeiliIndex] Error during cleanup:', error);
      }
    }

    /**
     * Updates settings for the MeiliSearch index
     */
    static async setMeiliIndexSettings(settings: Record<string, unknown>): Promise<unknown> {
      return await index.updateSettings(settings);
    }

    /**
     * Searches the MeiliSearch index and optionally populates results
     */
    static async meiliSearch(
      this: SchemaWithMeiliMethods,
      q: string,
      params: SearchParams,
      populate: boolean,
    ): Promise<SearchResponse<MeiliIndexable, Record<string, unknown>>> {
      const data = await index.search(q, params);

      if (populate) {
        const query: Record<string, unknown> = {};
        query[primaryKey] = _.map(data.hits, (hit) => hit[primaryKey]);

        const projection = Object.keys(this.schema.obj).reduce<Record<string, number>>(
          (results, key) => {
            if (!key.startsWith('$')) {
              results[key] = 1;
            }
            return results;
          },
          { _id: 1, __v: 1 },
        );

        const hitsFromMongoose = await this.find(query, projection).lean();

        const populatedHits = data.hits.map((hit) => {
          const queryObj: Record<string, unknown> = {};
          queryObj[primaryKey] = hit[primaryKey];
          const originalHit = _.find(hitsFromMongoose, (item) => {
            const typedItem = item as Record<string, unknown>;
            return typedItem[primaryKey] === hit[primaryKey];
          });

          return {
            ...(originalHit && typeof originalHit === 'object' ? originalHit : {}),
            ...hit,
          };
        });
        data.hits = populatedHits;
      }

      return data;
    }

    /**
     * Preprocesses the current document for indexing
     */
    preprocessObjectForIndex(this: DocumentWithMeiliIndex): Record<string, unknown> {
      const object = _.omitBy(_.pick(this.toJSON(), attributesToIndex), (v, k) =>
        k.startsWith('$'),
      );

      if (
        object.conversationId &&
        typeof object.conversationId === 'string' &&
        object.conversationId.includes('|')
      ) {
        object.conversationId = object.conversationId.replace(/\|/g, '--');
      }

      if (object.content && Array.isArray(object.content)) {
        /** Search indexes the full conversational record, steered words included. */
        object.text = parseTextParts(object.content, false, { includeSteer: true });
        delete object.content;
      }

      return object;
    }

    /** Adds the current document to the MeiliSearch index. */
    async addObjectToMeili(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): Promise<void> {
      if (!this._meiliIndexVersion) {
        return next();
      }
      try {
        await syncVersionedDocument(this, 'add');
      } catch (error) {
        logger.error('[addObjectToMeili] Error adding document to Meili:', error);
        return next();
      }
      next();
    }

    /**
     * Updates the current document in the MeiliSearch index
     */
    async updateObjectToMeili(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): Promise<void> {
      if (!this._meiliIndexVersion) {
        return next();
      }
      try {
        await syncVersionedDocument(this, 'update');
        next();
      } catch (error) {
        logger.error('[updateObjectToMeili] Error updating document in Meili:', error);
        return next();
      }
    }

    /**
     * Deletes the current document from the MeiliSearch index.
     *
     * @returns {Promise<void>}
     */
    async deleteObjectFromMeili(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): Promise<void> {
      try {
        await index.deleteDocument(String(this[primaryKey as keyof DocumentWithMeiliIndex]));
        next();
      } catch (error) {
        logger.error('[deleteObjectFromMeili] Error deleting document from Meili:', error);
        return next();
      }
    }

    /**
     * Post-save hook to synchronize the document with MeiliSearch.
     *
     * If the document is already indexed (i.e. `_meiliIndex` is true), it updates it;
     * otherwise, it adds the document to the index.
     */
    postSaveHook(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): Promise<void> {
      if (this.$locals?.[previouslyIndexedFlagKey] === true || this._meiliIndex) {
        return this.updateObjectToMeili!(next);
      }
      return this.addObjectToMeili!(next);
    }

    /**
     * Post-update hook to update the document in MeiliSearch.
     *
     * This hook is triggered after a document update, ensuring that changes are
     * propagated to the MeiliSearch index if the document is indexed.
     */
    postUpdateHook(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): void {
      if (this._meiliIndex) {
        this.updateObjectToMeili!(next);
      } else {
        next();
      }
    }

    /**
     * Post-remove hook to delete the document from MeiliSearch.
     *
     * This hook is triggered after a document is removed, ensuring that the document
     * is also removed from the MeiliSearch index if it was previously indexed.
     */
    postRemoveHook(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): void {
      if (this._meiliIndex) {
        this.deleteObjectFromMeili!(next);
      } else {
        next();
      }
    }
  }

  return MeiliMongooseModel;
};

/**
 * Mongoose plugin to synchronize MongoDB collections with a MeiliSearch index.
 *
 * This plugin:
 *   - Validates the provided options.
 *   - Adds a `_meiliIndex` field to the schema to track indexing status.
 *   - Sets up a MeiliSearch client and creates an index if it doesn't already exist.
 *   - Loads class methods for syncing, searching, and managing documents in MeiliSearch.
 *   - Registers Mongoose hooks (post-save, post-update, post-remove, etc.) to maintain index consistency.
 *
 * @param schema - The Mongoose schema to which the plugin is applied.
 * @param options - Configuration options.
 * @param options.host - The MeiliSearch host.
 * @param options.apiKey - The MeiliSearch API key.
 * @param options.indexName - The name of the MeiliSearch index.
 * @param options.primaryKey - The primary key field for indexing.
 * @param options.syncBatchSize - Batch size for sync operations.
 * @param options.syncDelayMs - Delay between batches in milliseconds.
 * @param options.excludeFromIndexPath - Presence of this path makes a document non-searchable.
 */
export default function mongoMeili(schema: Schema, options: MongoMeiliOptions): void {
  const mongoose = options.mongoose;
  validateOptions(options);

  // Add _meiliIndex field to the schema to track if a document has been indexed in MeiliSearch.
  schema.add({
    _meiliIndex: {
      type: Boolean,
      required: false,
      select: false,
      default: false,
    },
    _meiliIndexAttempted: {
      type: Boolean,
      required: false,
      select: false,
    },
    _meiliIndexVersion: {
      type: String,
      required: false,
      select: false,
    },
    _meiliIndexSchemaVersion: {
      type: Number,
      required: false,
      select: false,
    },
    _meiliCleanupVersion: {
      type: Number,
      required: false,
      select: false,
      default: meiliCleanupVersion,
    },
  });

  if (options.excludeFromIndexPath != null) {
    schema.index(
      { _meiliIndex: 1, [options.primaryKey]: 1 },
      {
        name: 'meili_excluded_indexed_cleanup_v3',
        partialFilterExpression: {
          [options.excludeFromIndexPath]: { $exists: true },
          _meiliIndex: { $eq: true },
        },
      },
    );
    schema.index(
      { _meiliIndexAttempted: 1, [options.primaryKey]: 1 },
      {
        name: 'meili_excluded_attempted_cleanup_v3',
        partialFilterExpression: {
          [options.excludeFromIndexPath]: { $exists: true },
          _meiliIndexAttempted: { $eq: true },
        },
      },
    );
    /* Serves the legacy branch of `buildExcludedIndexedQuery`. MongoDB rewrites
     * `$exists: false` into `$not`, which no `partialFilterExpression` accepts, so the
     * unstamped state is expressed as a null equality: it admits an absent or null
     * `_meiliCleanupVersion` and keeps every already-stamped document out, which is what
     * bounds this index to the shrinking legacy population rather than to every
     * excluded document ever written. Cleanup stamps the version, and the document
     * leaves the index. */
    schema.index(
      { _meiliIndex: 1, _meiliCleanupVersion: 1, [options.primaryKey]: 1 },
      {
        name: 'meili_excluded_legacy_cleanup_v4',
        partialFilterExpression: {
          [options.excludeFromIndexPath]: { $exists: true },
          _meiliIndex: { $eq: false },
          _meiliCleanupVersion: { $eq: null },
        },
      },
    );
  }

  const { host, apiKey, indexName, primaryKey } = options;
  const privateExcludedPath =
    options.excludeFromIndexPath != null &&
    schema.path(options.excludeFromIndexPath)?.options?.select === false
      ? options.excludeFromIndexPath
      : undefined;
  const queriesWithInjectedPrivatePath = new WeakSet<object>();
  const findOneAndUpdateVersions = new WeakMap<object, string>();
  const syncOptions = {
    batchSize: options.syncBatchSize || getSyncConfig().batchSize,
    delayMs: options.syncDelayMs || getSyncConfig().delayMs,
  };

  const client = new MeiliSearch({ host, apiKey, timeout: meiliRequestTimeoutMs });
  const runDetachedMeiliOperation = createDetachedMeiliRunner();
  const getOperationKey = (doc: DocumentWithMeiliIndex): string =>
    `${indexName}:${String(doc[primaryKey as keyof DocumentWithMeiliIndex] ?? doc._id)}`;

  /** Create index only if it doesn't exist */
  const index = client.index<MeiliIndexable>(indexName);

  (async () => {
    try {
      await index.getRawInfo();
      logger.debug(`[mongoMeili] Index ${indexName} already exists`);
    } catch (error) {
      const errorCode = (error as { code?: string })?.code;
      if (errorCode === 'index_not_found') {
        try {
          logger.info(`[mongoMeili] Creating new index: ${indexName}`);
          const enqueued = await client.createIndex(indexName, { primaryKey });
          const task = await client.waitForTask(enqueued.taskUid, {
            timeOutMs: 10000,
            intervalMs: 100,
          });
          logger.debug(`[mongoMeili] Index ${indexName} creation task:`, task);
          if (task.status !== 'succeeded') {
            const taskError = task.error as MeiliSearchErrorInfo | null;
            if (taskError?.code === 'index_already_exists') {
              logger.debug(`[mongoMeili] Index ${indexName} was created by another instance`);
            } else {
              logger.warn(`[mongoMeili] Index ${indexName} creation failed:`, taskError);
            }
          } else {
            logger.info(`[mongoMeili] Successfully created index: ${indexName}`);
          }
        } catch (createError) {
          if (createError instanceof MeiliSearchTimeOutError) {
            logger.warn(`[mongoMeili] Timed out waiting for index ${indexName} creation`);
          } else {
            logger.warn(`[mongoMeili] Error creating index ${indexName}:`, createError);
          }
        }
      } else {
        logger.error(`[mongoMeili] Error checking index ${indexName}:`, error);
      }
    }

    try {
      await index.updateSettings({
        filterableAttributes: ['user'],
      });
      logger.debug(`[mongoMeili] Updated index ${indexName} settings to make 'user' filterable`);
    } catch (settingsError) {
      logger.error(`[mongoMeili] Error updating index settings for ${indexName}:`, settingsError);
    }
  })();

  // Collect attributes from the schema that should be indexed
  const attributesToIndex: string[] = [
    ...Object.entries(schema.obj).reduce<string[]>((results, [key, value]) => {
      const schemaValue = value as { meiliIndex?: boolean };
      return schemaValue.meiliIndex ? [...results, key] : results;
    }, []),
  ];

  // CRITICAL: Always include 'user' field for proper filtering
  // This ensures existing deployments can filter by user after migration
  if (schema.obj.user && !attributesToIndex.includes('user')) {
    attributesToIndex.push('user');
    logger.debug(`[mongoMeili] Added 'user' field to ${indexName} index attributes`);
  }

  schema.loadClass(
    createMeiliMongooseModel({
      client,
      index,
      getIndexableQuery: () => buildIndexableQuery(schema, options.excludeFromIndexPath),
      getExcludedIndexedQuery: () => buildExcludedIndexedQuery(options.excludeFromIndexPath),
      excludeFromIndexPath: options.excludeFromIndexPath,
      attributesToIndex,
      primaryKey,
      syncOptions,
    }),
  );

  // Register Mongoose hooks
  schema.pre('save', function (this: DocumentWithMeiliIndex, next) {
    if (hasSchemaPath(schema, 'isTemporary')) {
      captureExplicitTemporaryFlag(this);
    }
    this.$locals[previouslyIndexedFlagKey] = this._meiliIndex === true;
    if (
      isIndexableDocument(this, options.excludeFromIndexPath) ||
      this._meiliIndex === true ||
      this._meiliIndexAttempted === true
    ) {
      this._meiliIndexVersion = new mongoose.Types.ObjectId().toString();
      this._meiliIndex = false;
      this._meiliIndexAttempted = true;
      this.markModified('_meiliIndexVersion');
      this.markModified('_meiliIndex');
      this.markModified('_meiliIndexAttempted');
    }
    next();
  });

  schema.post('save', function (doc: DocumentWithMeiliIndex, next) {
    next();
    if (typeof doc.postSaveHook === 'function') {
      runDetachedMeiliOperation(
        getOperationKey(doc),
        () => doc.postSaveHook!(completeDetachedOperation),
        '[mongoMeili] Detached post-save indexing failed:',
      );
    }
  });

  schema.pre('findOneAndUpdate', function (next) {
    if (queriesWithoutMeiliIndexing.has(this)) {
      next();
      return;
    }
    const query = this as Query<unknown, unknown>;
    if (meiliEnabled) {
      const version = new mongoose.Types.ObjectId().toString();
      query.set({
        _meiliIndex: false,
        _meiliIndexAttempted: true,
        _meiliIndexVersion: version,
      });
      findOneAndUpdateVersions.set(query, version);
    }
    if (privateExcludedPath != null) {
      const projection = query.projection() as Record<string, number> | null;
      const callerRequestedPrivatePath = Object.entries(projection ?? {}).some(
        ([path, included]) =>
          included === 1 &&
          (path === privateExcludedPath ||
            path === `+${privateExcludedPath}` ||
            path.startsWith(`${privateExcludedPath}.`)),
      );
      if (!callerRequestedPrivatePath) {
        query.select(`+${privateExcludedPath}`);
        queriesWithInjectedPrivatePath.add(query);
      }
    }
    next();
  });

  schema.post('updateOne', function (doc: DocumentWithMeiliIndex, next) {
    next();
    if (typeof doc.postUpdateHook === 'function') {
      runDetachedMeiliOperation(
        getOperationKey(doc),
        () => doc.postUpdateHook!(completeDetachedOperation),
        '[mongoMeili] Detached post-update indexing failed:',
      );
    }
  });

  schema.post('deleteOne', function (doc: DocumentWithMeiliIndex, next) {
    next();
    if (typeof doc.postRemoveHook === 'function') {
      runDetachedMeiliOperation(
        getOperationKey(doc),
        () => doc.postRemoveHook!(completeDetachedOperation),
        '[mongoMeili] Detached post-remove indexing failed:',
      );
    }
  });

  // Pre-deleteMany hook: remove corresponding documents from MeiliSearch when multiple documents are deleted.
  schema.pre('deleteMany', async function (next) {
    if (!meiliEnabled) {
      return next();
    }

    try {
      const conditions = (this as Query<unknown, unknown>).getQuery();
      const { batchSize, delayMs } = syncOptions;

      if (Object.prototype.hasOwnProperty.call(schema.obj, 'messages')) {
        const convoIndex = client.index('convos');
        const deletedConvos = await mongoose
          .model('Conversation')
          .find(conditions as FilterQuery<unknown>)
          .select('conversationId')
          .lean();

        // Process deletions in batches
        await processBatch(deletedConvos, batchSize, delayMs, async (batch) => {
          const promises = batch.map((convo: Record<string, unknown>) =>
            convoIndex.deleteDocument(convo.conversationId as string),
          );
          await Promise.all(promises);
        });
      }

      if (Object.prototype.hasOwnProperty.call(schema.obj, 'messageId')) {
        const messageIndex = client.index('messages');
        const deletedMessages = await mongoose
          .model('Message')
          .find(conditions as FilterQuery<unknown>)
          .select('messageId')
          .lean();

        // Process deletions in batches
        await processBatch(deletedMessages, batchSize, delayMs, async (batch) => {
          const promises = batch.map((message: Record<string, unknown>) =>
            messageIndex.deleteDocument(message.messageId as string),
          );
          await Promise.all(promises);
        });
      }
      return next();
    } catch (error) {
      if (meiliEnabled) {
        logger.error(
          '[MeiliMongooseModel.deleteMany] There was an issue deleting conversation indexes upon deletion. Next startup may trigger syncing.',
          error,
        );
      }
      return next();
    }
  });

  // Post-findOneAndUpdate hook
  schema.post(
    'findOneAndUpdate',
    function (
      res: DocumentWithMeiliIndex | { value: DocumentWithMeiliIndex | null } | null,
      next: CallbackWithoutResultAndOptionalError,
    ) {
      // `saveConvo` issues `findOneAndUpdate` with `includeResultMetadata: true`, so
      // the hook receives the raw `{ value, ok, lastErrorObject }` result instead of
      // the document. Unwrap `value` so indexing runs for that path too.
      let doc: DocumentWithMeiliIndex | null;
      if (res instanceof mongoose.Document) {
        doc = res;
      } else if (res != null && 'value' in res) {
        doc = res.value;
      } else {
        doc = res;
      }
      if (doc != null && privateExcludedPath != null && queriesWithInjectedPrivatePath.has(this)) {
        if (doc instanceof mongoose.Document) {
          doc.set(privateExcludedPath, undefined);
        } else {
          _.unset(doc, privateExcludedPath);
        }
      }

      const version = findOneAndUpdateVersions.get(this);
      if (!meiliEnabled || !doc || !version) {
        next();
        return;
      }

      const savedDoc = doc;
      const model = (this as Query<unknown, DocumentWithMeiliIndex>).model;
      next();
      runDetachedMeiliOperation(
        getOperationKey(savedDoc),
        async () => {
          const latestDoc = await model
            .findById(savedDoc._id)
            .select(
              [
                '+_meiliIndex',
                '+_meiliIndexAttempted',
                '+_meiliIndexVersion',
                ...(privateExcludedPath == null ? [] : [`+${privateExcludedPath}`]),
              ].join(' '),
            )
            .exec();
          await latestDoc?.addObjectToMeili?.(completeDetachedOperation);
        },
        '[mongoMeili] Detached findOneAndUpdate indexing failed:',
      );
    },
  );
}
