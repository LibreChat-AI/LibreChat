import type { AnyBulkWriteOperation, Document } from 'mongodb';
import type { Connection } from 'mongoose';
import type { SearchTokenField } from '~/utils/search';
import {
  searchTokenIndexes,
  computeSearchTokenSet,
  USER_SEARCH_TOKEN_FIELDS,
  GROUP_SEARCH_TOKEN_FIELDS,
} from '~/utils/search';
import { buildIndexWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

const DEFAULT_BATCH_SIZE = 500;
/** Upper bound on the startup probe, in case it runs before the token indexes exist. */
const STARTUP_PROBE_MAX_TIME_MS = 5_000;

const SEARCH_TOKEN_COLLECTIONS: ReadonlyArray<{
  name: string;
  fields: readonly SearchTokenField[];
}> = [
  { name: 'users', fields: USER_SEARCH_TOKEN_FIELDS },
  { name: 'groups', fields: GROUP_SEARCH_TOKEN_FIELDS },
];

export interface SearchTokenBackfillResult {
  /** Documents whose token fields are missing or no longer match their source, per collection. */
  pending: Record<string, number>;
  /** Documents written, per collection; zero on a dry run. */
  updated: Record<string, number>;
}

/** Index-bound: each branch seeks one token index on its missing-key bounds. */
function missingTokens(fields: readonly SearchTokenField[]): Document {
  return { $or: fields.map((field) => ({ [field.tokens]: { $exists: false } })) };
}

function sameTokens(stored: unknown, expected: string[]): boolean {
  return (
    Array.isArray(stored) &&
    stored.length === expected.length &&
    stored.every((token, index) => token === expected[index])
  );
}

/**
 * Brings the search-token arrays on users and groups in line with their source
 * fields: fills documents saved before the tokens existed and repairs tokens
 * left stale by a writer that did not maintain them (an older server during a
 * rolling deploy, a raw collection write). Every document is read and only the
 * ones whose tokens differ are written, so it is idempotent and resumable; run
 * it again once a rollout completes. Each write is guarded by the source values
 * it was computed from, so a concurrent rename (whose own update already wrote
 * fresh tokens) is skipped. Runs across all tenants on the raw collections; the
 * `_id` filter keeps every write on its own document, and `tenantId` is never
 * written.
 */
export async function backfillSearchTokens(
  connection: Connection,
  options: { batchSize?: number; dryRun?: boolean } = {},
): Promise<SearchTokenBackfillResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const result: SearchTokenBackfillResult = { pending: {}, updated: {} };

  for (const { name, fields } of SEARCH_TOKEN_COLLECTIONS) {
    const collection = connection.db!.collection(name);
    if (!options.dryRun) {
      /** Deployments running with `MONGO_AUTO_INDEX` off never build schema indexes, and
       *  without these the token filters would scan the collection. Same specs and default
       *  names as the schema declaration, so this is a no-op where Mongoose already built them. */
      for (const field of fields) {
        for (const index of searchTokenIndexes(field)) {
          await buildIndexWithRetry(
            () => collection.createIndex(index),
            `createIndex(${name}.${Object.keys(index).join('_')})`,
          );
        }
      }
    }
    result.pending[name] = 0;
    result.updated[name] = 0;

    const projection = Object.fromEntries(
      fields.flatMap((field) => [
        [field.source, 1],
        [field.tokens, 1],
      ]),
    );
    let batch: AnyBulkWriteOperation[] = [];
    const flush = async () => {
      if (batch.length === 0) {
        return;
      }
      // eslint-disable-next-line no-restricted-syntax -- offline all-tenant migration; `_id` filters keep each write on its own document
      const written = await collection.bulkWrite(batch, { ordered: false });
      result.updated[name] += written.modifiedCount;
      batch = [];
    };

    for await (const doc of collection.find({}, { projection })) {
      const expected = computeSearchTokenSet(fields, doc);
      if (fields.every((field) => sameTokens(doc[field.tokens], expected[field.tokens]))) {
        continue;
      }
      result.pending[name] += 1;
      if (options.dryRun) {
        continue;
      }
      const guard = Object.fromEntries(
        fields.map((field) => [field.source, doc[field.source] ?? null]),
      );
      batch.push({ updateOne: { filter: { _id: doc._id, ...guard }, update: { $set: expected } } });
      if (batch.length >= batchSize) {
        await flush();
      }
    }
    await flush();
    if (!options.dryRun) {
      logger.info(
        `[SearchTokenMigration] ${name}: ${result.updated[name]} of ${result.pending[name]} documents updated`,
      );
    }
  }
  return result;
}

/**
 * Logs a startup warning when users or groups still lack search tokens. Those
 * documents stay findable through the slower unindexed fallback until
 * `npm run migrate:search-tokens` runs. A best-effort diagnostic: a failed
 * check is logged and never blocks startup.
 *
 * Also warns when the token indexes are missing: with `MONGO_AUTO_INDEX` off,
 * a database whose documents all received tokens from the schema middleware
 * still never builds them until the backfill runs.
 *
 * The indexes are checked first, so the probe for a token-less document only
 * runs once they exist and it can seek them; `maxTimeMS` bounds it regardless.
 */
export async function warnOnMissingSearchTokens(connection: Connection): Promise<void> {
  try {
    const pending = await Promise.all(
      SEARCH_TOKEN_COLLECTIONS.map(async ({ name, fields }) => {
        const collection = connection.db!.collection(name);
        const indexes = await collection.indexes().catch((error: { codeName?: string }) => {
          /** No collection yet: nothing to search, nothing to migrate. */
          if (error?.codeName === 'NamespaceNotFound') {
            return null;
          }
          throw error;
        });
        if (indexes == null) {
          return null;
        }
        const built = new Set(indexes.map((index) => JSON.stringify(index.key)));
        const unindexed = fields.some((field) =>
          searchTokenIndexes(field).some((index) => !built.has(JSON.stringify(index))),
        );
        /** Without the indexes the probe below would scan; the warning is already due. */
        if (unindexed) {
          return name;
        }
        const unmigrated = await collection.findOne(missingTokens(fields), {
          projection: { _id: 1 },
          maxTimeMS: STARTUP_PROBE_MAX_TIME_MS,
        });
        return unmigrated != null ? name : null;
      }),
    );
    const names = pending.filter((name): name is string => name != null);
    if (names.length > 0) {
      logger.warn(
        `[SearchTokenMigration] Some ${names.join(' and ')} lack search tokens or their indexes; people search scans the collection until you run: npm run migrate:search-tokens`,
      );
    }
  } catch (error) {
    logger.error('[SearchTokenMigration] Failed to check search token migration:', error);
  }
}
