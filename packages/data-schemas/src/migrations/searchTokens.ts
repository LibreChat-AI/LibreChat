import type { AnyBulkWriteOperation, Document } from 'mongodb';
import type { Connection } from 'mongoose';
import type { SearchTokenField } from '~/utils/search';
import {
  computeSearchTokenSet,
  USER_SEARCH_TOKEN_FIELDS,
  GROUP_SEARCH_TOKEN_FIELDS,
} from '~/utils/search';
import { buildIndexWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

const DEFAULT_BATCH_SIZE = 500;

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
       *  without these the token filters would scan the collection. Same spec and default
       *  name as the schema declaration, so this is a no-op where Mongoose already built it. */
      for (const field of fields) {
        await buildIndexWithRetry(
          () => collection.createIndex({ [field.tokens]: 1, tenantId: 1 }),
          `createIndex(${name}.${field.tokens})`,
        );
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
 */
export async function warnOnMissingSearchTokens(connection: Connection): Promise<void> {
  try {
    const counts = await Promise.all(
      SEARCH_TOKEN_COLLECTIONS.map(({ name, fields }) =>
        connection.db!.collection(name).countDocuments(missingTokens(fields)),
      ),
    );
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      logger.warn(
        `[SearchTokenMigration] ${total} users and groups lack search tokens; people search scans the collection for them until you run: npm run migrate:search-tokens`,
      );
    }
  } catch (error) {
    logger.error('[SearchTokenMigration] Failed to check search token migration:', error);
  }
}
