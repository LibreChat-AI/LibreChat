'use strict';

const { MongoClient } = require('mongodb');
const { logger } = require('@librechat/data-schemas');
const { buildAutoEncryptionOptions } = require('./index');

/** Collection used to persist migration state. */
const MIGRATIONS_COLL = '__csfle_migrations';

/** Status values stored in migration state documents. */
const STATUS = Object.freeze({ APPLIED: 'applied', FAILED: 'failed', PENDING: 'pending' });

/**
 * Single migration descriptor: backfill messages.text and messages.content.
 * Version is fixed at 1 — there is no version registry.
 */
const MESSAGES_MIGRATION = Object.freeze({
  version: 1,
  description: 'Backfill messages.text and messages.content with CSFLE encryption',
  fields: ['text', 'content'],
});

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
  const subType = value.sub_type ?? value.subType;
  return value._bsontype === 'Binary' && subType === 6;
}

/**
 * Back-fills the messages collection: reads plaintext docs through the plain
 * client and re-saves them through the encrypted client so the driver applies
 * automatic field-level encryption.
 *
 * Uses a DB-level `$not: { $type: 'binData' }` filter so only plaintext docs
 * are fetched. Empty strings are included; already-encrypted BinData blobs
 * are excluded at the database level.
 *
 * Uses `updateOne + $set` to update only the target fields without touching
 * any other document fields (conversationId, sender, model, etc.).
 *
 * @param {import('mongodb').Collection} rawColl   Plain view.
 * @param {import('mongodb').Collection} encColl   Encrypted-client view.
 * @param {string[]} fields   Fields to encrypt.
 * @param {{ dryRun: boolean, batchSize: number }} opts
 * @returns {Promise<{ migrated: number, skipped: number, errors: number }>}
 */
async function backfillCollection(rawColl, encColl, fields, { dryRun, batchSize }) {
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
 * Core migration runner. Opens dedicated MongoClient instances (one encrypted,
 * one plain) and backfills the messages collection.
 *
 * Set `CSFLE_FORCE_REMIGRATE=true` to re-run even when migration is already
 * marked APPLIED (use after a bug-fix to encrypt docs that were missed).
 *
 * @param {object} opts
 * @param {string}  opts.mongoUri
 * @param {boolean} opts.dryRun
 * @param {number}  opts.batchSize
 * @returns {Promise<void>}
 */
async function runMigrations({ mongoUri, dryRun = false, batchSize = 100 }) {
  const autoEncryption = await buildAutoEncryptionOptions(mongoUri);
  const encClient = new MongoClient(mongoUri, { autoEncryption });
  const rawClient = new MongoClient(mongoUri);

  try {
    await Promise.all([encClient.connect(), rawClient.connect()]);

    const dbName = new URL(mongoUri).pathname.replace(/^\//, '') || 'LibreChat';
    const encDb = encClient.db(dbName);
    const rawDb = rawClient.db(dbName);

    const migrationsColl = rawDb.collection(MIGRATIONS_COLL);
    await migrationsColl.createIndex({ version: 1 }, { unique: true });

    const existing = await migrationsColl.findOne({ version: MESSAGES_MIGRATION.version });
    const forceRemigrate = process.env.CSFLE_FORCE_REMIGRATE === 'true';

    if (existing?.status === STATUS.APPLIED && !forceRemigrate) {
      logger.debug('[CSFLE manager] Messages migration already applied — skipping');
      return;
    }

    if (existing?.status === STATUS.APPLIED && forceRemigrate) {
      logger.warn(
        '[CSFLE manager] FORCE_REMIGRATE=true — re-running to encrypt any remaining plaintext docs',
      );
    }

    logger.info(`[CSFLE manager] Running: ${MESSAGES_MIGRATION.description}`);

    await migrationsColl.updateOne(
      { version: MESSAGES_MIGRATION.version },
      {
        $set: {
          version: MESSAGES_MIGRATION.version,
          description: MESSAGES_MIGRATION.description,
          status: STATUS.PENDING,
          startedAt: new Date(),
        },
      },
      { upsert: true },
    );

    const stats = await backfillCollection(
      rawDb.collection('messages'),
      encDb.collection('messages'),
      MESSAGES_MIGRATION.fields,
      { dryRun, batchSize },
    );

    logger.info(
      `[CSFLE manager] messages: migrated=${stats.migrated} skipped=${stats.skipped} errors=${stats.errors}`,
    );

    const finalStatus =
      dryRun ? STATUS.PENDING : stats.errors === 0 ? STATUS.APPLIED : STATUS.FAILED;
    await migrationsColl.updateOne(
      { version: MESSAGES_MIGRATION.version },
      { $set: { status: finalStatus, appliedAt: new Date(), stats } },
    );

    if (!dryRun && stats.errors > 0) {
      throw new Error(
        `[CSFLE manager] Messages backfill completed with ${stats.errors} errors — see logs above`,
      );
    }
  } finally {
    await encClient.close();
    await rawClient.close();
  }
}

/**
 * Called at app startup when CSFLE_AUTO_MIGRATE=true.
 *
 * Env vars read:
 *   CSFLE_STARTUP_POLICY   = strict | warn  (default: strict)
 *   CSFLE_FORCE_REMIGRATE  = true           (re-run applied migration; single-use)
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

  logger.info(
    `[CSFLE manager] Auto-migrate starting (policy=${startupPolicy}` +
      `${process.env.CSFLE_FORCE_REMIGRATE === 'true' ? ', force-remigrate=true' : ''})`,
  );

  try {
    await runMigrations({ mongoUri: uri, dryRun: false, batchSize: 100 });
    logger.info('[CSFLE manager] Auto-migrate complete');
  } catch (err) {
    if (strict) {
      logger.error(
        `[CSFLE manager] Migration failed (strict mode) — aborting startup: ${err.message}`,
      );
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
  MESSAGES_MIGRATION,
  STATUS,
  isEncrypted,
};