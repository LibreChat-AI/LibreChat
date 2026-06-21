'use strict';

const { MongoClient } = require('mongodb');
const { logger } = require('@librechat/data-schemas');
const { buildAutoEncryptionOptions } = require('./index');
const { POLICIES, getPoliciesUpTo, computeChecksum, getCollectionFields } = require('./policies');

/** Collection used to persist migration state. */
const MIGRATIONS_COLL = '__csfle_migrations';

/** Status values stored in migration state documents. */
const STATUS = Object.freeze({ APPLIED: 'applied', FAILED: 'failed', PENDING: 'pending' });

/**
 * Returns true when a BSON value is already CSFLE-encrypted
 * (Binary subtype 6 — the FLE2 ciphertext subtype).
 *
 * Handles both bson v4 (`sub_type`) and v5+ (`subType`) property names.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  if (value == null || typeof value !== 'object') return false;
  // bson v4 uses sub_type; v5+ uses subType — check both for compatibility
  const subType = value.sub_type ?? value.subType;
  return value._bsontype === 'Binary' && subType === 6;
}

/**
 * Back-fills a single collection for a policy: reads plaintext docs through
 * the plain client and re-saves them through the encrypted client so the
 * driver applies automatic field-level encryption.
 *
 * Uses a DB-level `$not: { $type: 'binData' }` filter so only plaintext docs
 * are fetched, which means empty strings (`""`) are included while
 * already-encrypted BinData blobs are excluded naturally.
 *
 * Uses `updateOne + $set` (not `replaceOne`) to update only the target fields
 * without touching any other document fields.
 *
 * @param {import('mongodb').Collection} rawColl   Plain view.
 * @param {import('mongodb').Collection} encColl   Encrypted-client view.
 * @param {string[]} fields   Fields belonging to this policy for this collection.
 * @param {{ dryRun: boolean, batchSize: number }} opts
 * @returns {Promise<{ migrated: number, skipped: number, errors: number }>}
 */
async function backfillCollection(rawColl, encColl, fields, { dryRun, batchSize }) {
  // Only fetch documents where at least one target field is present and not yet
  // a BinData blob.  $ne: null ensures we don't try to encrypt null values, but
  // empty strings ('') are correctly included because '' !== null.
  const filter = {
    $or: fields.map((f) => ({
      [f]: { $exists: true, $not: { $type: 'binData' }, $ne: null },
    })),
  };

  const projection = { _id: 1, ...Object.fromEntries(fields.map((f) => [f, 1])) };
  const cursor = rawColl.find(filter, { projection, batchSize });

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  try {
    for await (const doc of cursor) {
      const $set = {};
      for (const f of fields) {
        const val = doc[f];
        if (val !== undefined && val !== null && !isEncrypted(val)) {
          $set[f] = val;
        }
      }

      if (Object.keys($set).length === 0) {
        skipped++;
        continue;
      }

      if (dryRun) {
        migrated++;
        continue;
      }

      try {
        // updateOne + $set so only the encrypted fields are touched;
        // all other document fields (conversationId, sender, etc.) are preserved.
        await encColl.updateOne({ _id: doc._id }, { $set });
        migrated++;
      } catch (err) {
        logger.error(`[CSFLE manager] updateOne failed for _id=${doc._id}: ${err.message}`);
        errors++;
      }
    }
  } finally {
    await cursor.close();
  }

  return { migrated, skipped, errors };
}

/**
 * Applies one policy version: back-fills all its collections and writes the
 * result to __csfle_migrations.
 *
 * @param {import('mongodb').Db} encDb
 * @param {import('mongodb').Db} rawDb
 * @param {object} policy
 * @param {{ dryRun: boolean, batchSize: number }} opts
 * @returns {Promise<void>}
 */
async function applyPolicy(encDb, rawDb, policy, opts) {
  const migrationsColl = rawDb.collection(MIGRATIONS_COLL);
  const checksum = computeChecksum(policy);

  await migrationsColl.updateOne(
    { version: policy.version },
    { $set: { version: policy.version, description: policy.description, checksum, status: STATUS.PENDING, startedAt: new Date() } },
    { upsert: true },
  );

  const collectionFields = getCollectionFields(policy);
  const totalStats = { migrated: 0, skipped: 0, errors: 0 };

  for (const [collName, fields] of Object.entries(collectionFields)) {
    logger.info(
      `[CSFLE manager] v${policy.version} — ${collName}: fields=[${fields.join(', ')}]${opts.dryRun ? ' (dry-run)' : ''}`,
    );
    const stats = await backfillCollection(
      rawDb.collection(collName),
      encDb.collection(collName),
      fields,
      opts,
    );
    logger.info(
      `[CSFLE manager] v${policy.version} — ${collName}: migrated=${stats.migrated} skipped=${stats.skipped} errors=${stats.errors}`,
    );
    totalStats.migrated += stats.migrated;
    totalStats.skipped += stats.skipped;
    totalStats.errors += stats.errors;
  }

  const finalStatus =
    opts.dryRun ? STATUS.PENDING : totalStats.errors === 0 ? STATUS.APPLIED : STATUS.FAILED;
  await migrationsColl.updateOne(
    { version: policy.version },
    { $set: { status: finalStatus, appliedAt: new Date(), stats: totalStats } },
  );
}

/**
 * Core migration runner.  Opens dedicated MongoClient instances (one encrypted,
 * one plain) so this function works both at startup and via any external invocation.
 *
 * @param {object} opts
 * @param {string}  opts.mongoUri
 * @param {number | null} opts.targetVersion   Apply up to this version (null = all).
 * @param {boolean} opts.dryRun
 * @param {number}  opts.batchSize
 * @returns {Promise<void>}
 */
async function runMigrations({ mongoUri, targetVersion = null, dryRun = false, batchSize = 100 }) {
  const autoEncryption = await buildAutoEncryptionOptions(mongoUri);
  const encClient = new MongoClient(mongoUri, { autoEncryption });
  const rawClient = new MongoClient(mongoUri);

  try {
    await Promise.all([encClient.connect(), rawClient.connect()]);

    const dbName = new URL(mongoUri).pathname.replace(/^\//, '') || 'LibreChat';
    const encDb = encClient.db(dbName);
    const rawDb = rawClient.db(dbName);

    const pending = getPoliciesUpTo(targetVersion);
    const migrationsColl = rawDb.collection(MIGRATIONS_COLL);

    await migrationsColl.createIndex({ version: 1 }, { unique: true });

    const forceRemigrate = process.env.CSFLE_FORCE_REMIGRATE === 'true';

    for (const policy of pending) {
      const existing = await migrationsColl.findOne({ version: policy.version });

      if (existing?.status === STATUS.APPLIED) {
        const currentChecksum = computeChecksum(policy);
        if (existing.checksum !== currentChecksum) {
          logger.warn(
            `[CSFLE manager] CHECKSUM MISMATCH for v${policy.version}: ` +
              `stored=${existing.checksum} current=${currentChecksum}. ` +
              'Policy fields were modified after initial application — this is dangerous in production.',
          );
        }
        if (!forceRemigrate) {
          logger.debug(`[CSFLE manager] v${policy.version} already applied — skipping`);
          continue;
        }
        logger.warn(
          `[CSFLE manager] FORCE_REMIGRATE=true — re-running v${policy.version} to encrypt any remaining plaintext docs`,
        );
      }

      logger.info(`[CSFLE manager] Applying v${policy.version}: ${policy.description}`);
      await applyPolicy(encDb, rawDb, policy, { dryRun, batchSize });
      logger.info(`[CSFLE manager] v${policy.version} ${dryRun ? 'dry-run complete' : 'applied'}`);
    }
  } finally {
    await encClient.close();
    await rawClient.close();
  }
}

/**
 * Called at app startup when CSFLE_AUTO_MIGRATE=true.
 *
 * Reads policy from env:
 *   CSFLE_STARTUP_POLICY            = strict | warn  (default: strict)
 *   CSFLE_MIGRATION_TARGET_VERSION  = <number>  (optional; applies all if absent)
 *
 * In strict mode any migration failure throws, which aborts startup.
 * In warn mode failures are logged but startup continues.
 *
 * @param {string} mongoUri
 * @returns {Promise<void>}
 */
async function runStartupMigration(mongoUri) {
  const uri = mongoUri || process.env.MONGO_URI;
  if (!uri) throw new Error('[CSFLE manager] MONGO_URI is required');

  const startupPolicy = (process.env.CSFLE_STARTUP_POLICY || 'strict').toLowerCase();
  const strict = startupPolicy !== 'warn';

  const rawTarget = process.env.CSFLE_MIGRATION_TARGET_VERSION;
  const targetVersion = rawTarget != null && rawTarget !== '' ? parseInt(rawTarget, 10) : null;

  logger.info(
    `[CSFLE manager] Auto-migrate starting (policy=${startupPolicy}` +
      `${targetVersion != null ? `, target=v${targetVersion}` : ''}` +
      `${process.env.CSFLE_FORCE_REMIGRATE === 'true' ? ', force-remigrate=true' : ''})`,
  );

  try {
    await runMigrations({ mongoUri: uri, targetVersion, dryRun: false, batchSize: 100 });
    logger.info('[CSFLE manager] Auto-migrate complete');
  } catch (err) {
    if (strict) {
      logger.error(`[CSFLE manager] Migration failed (strict mode) — aborting startup: ${err.message}`);
      throw err;
    }
    logger.warn(`[CSFLE manager] Migration failed (warn mode) — continuing startup: ${err.message}`);
  }
}

module.exports = {
  runMigrations,
  runStartupMigration,
  backfillCollection,
  MIGRATIONS_COLL,
  STATUS,
  isEncrypted,
};
