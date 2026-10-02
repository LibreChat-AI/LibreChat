const crypto = require('crypto');
const { logger, buildRetentionVisibilityFilter } = require('@librechat/data-schemas');

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Meili reset cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Meili reset cancelled');
  }
};

/**
 * Batch update documents in chunks to avoid timeouts on weak instances
 * @param {mongoose.Collection} collection - MongoDB collection
 * @param {{signal?: AbortSignal}} options - Reset options
 * @returns {Promise<number>} - Total modified count
 * @throws {Error} - Throws if database operations fail (e.g., network issues, connection loss, permission problems)
 */
async function batchResetMeiliFlags(collection, options = {}) {
  const DEFAULT_BATCH_SIZE = 1000;

  let BATCH_SIZE = parseEnvInt('MEILI_SYNC_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  if (BATCH_SIZE === 0) {
    logger.warn(
      `[batchResetMeiliFlags] MEILI_SYNC_BATCH_SIZE cannot be 0. Using default: ${DEFAULT_BATCH_SIZE}`,
    );
    BATCH_SIZE = DEFAULT_BATCH_SIZE;
  }

  const BATCH_DELAY_MS = parseEnvInt('MEILI_SYNC_DELAY_MS', 100);
  let totalModified = 0;
  let hasMore = true;

  try {
    while (hasMore) {
      throwIfAborted(options.signal);
      const docs = await collection
        .find(
          { ...buildRetentionVisibilityFilter(), _meiliIndex: { $ne: false } },
          { projection: { _id: 1 } },
        )
        .limit(BATCH_SIZE)
        .toArray();
      throwIfAborted(options.signal);

      if (docs.length === 0) {
        break;
      }

      const ids = docs.map((doc) => doc._id);
      const result = await collection.updateMany(
        { _id: { $in: ids } },
        { $set: { _meiliIndex: false, _meiliIndexAttempted: true } },
      );
      throwIfAborted(options.signal);

      totalModified += result.modifiedCount;
      process.stdout.write(
        `\r  Updating ${collection.collectionName}: ${totalModified} documents...`,
      );

      if (docs.length < BATCH_SIZE) {
        hasMore = false;
      }

      if (hasMore && BATCH_DELAY_MS > 0) {
        await sleep(BATCH_DELAY_MS, options.signal);
      }
    }

    return totalModified;
  } catch (error) {
    throw new Error(
      `Failed to batch reset Meili flags for collection '${collection.collectionName}' after processing ${totalModified} documents: ${error.message}`,
    );
  }
}

async function getMeiliRebuildState(collection, indexName, options = {}) {
  throwIfAborted(options.signal);
  const state = await collection.findOne({ _id: indexName });
  throwIfAborted(options.signal);
  return state;
}

async function requestMeiliRebuild(collection, indexName, options = {}) {
  throwIfAborted(options.signal);
  const existing = await getMeiliRebuildState(collection, indexName, options);
  if (existing?.phase === 'resetting') {
    return existing;
  }

  const now = new Date();
  const state = await collection.findOneAndUpdate(
    { _id: indexName },
    {
      $set: {
        generation: crypto.randomUUID(),
        phase: 'resetting',
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    {
      upsert: true,
      returnDocument: 'after',
      includeResultMetadata: false,
    },
  );
  throwIfAborted(options.signal);
  return state;
}

async function markMeiliRebuildSyncing(collection, indexName, generation, options = {}) {
  throwIfAborted(options.signal);
  const result = await collection.findOneAndUpdate(
    { _id: indexName, generation, phase: 'resetting' },
    { $set: { phase: 'syncing', updatedAt: new Date() } },
    {
      returnDocument: 'after',
      includeResultMetadata: false,
    },
  );
  throwIfAborted(options.signal);
  if (!result) {
    throw new Error(`Meili rebuild generation changed while resetting ${indexName}`);
  }
  return result;
}

async function completeMeiliRebuild(collection, indexName, generation, options = {}) {
  throwIfAborted(options.signal);
  const result = await collection.deleteOne({ _id: indexName, generation, phase: 'syncing' });
  throwIfAborted(options.signal);
  if (result.deletedCount !== 1) {
    throw new Error(`Meili rebuild generation changed while completing ${indexName}`);
  }
}

/**
 * Parse and validate an environment variable as a positive integer
 * @param {string} varName - Environment variable name
 * @param {number} defaultValue - Default value to use if invalid or missing
 * @returns {number} - Parsed value or default
 */
function parseEnvInt(varName, defaultValue) {
  const value = process.env[varName];
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) {
    logger.warn(
      `[batchResetMeiliFlags] Invalid value for ${varName}="${value}". Expected a positive integer. Using default: ${defaultValue}`,
    );
    return defaultValue;
  }

  return parsed;
}

module.exports = {
  batchResetMeiliFlags,
  getMeiliRebuildState,
  requestMeiliRebuild,
  markMeiliRebuildSyncing,
  completeMeiliRebuild,
};
