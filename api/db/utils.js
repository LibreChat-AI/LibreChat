const { logger, buildRetentionVisibilityFilter } = require('@librechat/data-schemas');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Batch update documents in chunks to avoid timeouts on weak instances
 * @param {mongoose.Collection} collection - MongoDB collection
 * @returns {Promise<number>} - Total modified count
 * @throws {Error} - Throws if database operations fail (e.g., network issues, connection loss, permission problems)
 */
async function batchResetMeiliFlags(collection) {
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
      const docs = await collection
        .find(
          { ...buildRetentionVisibilityFilter(), _meiliIndex: { $ne: false } },
          { projection: { _id: 1 } },
        )
        .limit(BATCH_SIZE)
        .toArray();

      if (docs.length === 0) {
        break;
      }

      const ids = docs.map((doc) => doc._id);
      const result = await collection.updateMany(
        { _id: { $in: ids } },
        { $set: { _meiliIndex: false } },
      );

      totalModified += result.modifiedCount;
      process.stdout.write(
        `\r  Updating ${collection.collectionName}: ${totalModified} documents...`,
      );

      if (docs.length < BATCH_SIZE) {
        hasMore = false;
      }

      if (hasMore && BATCH_DELAY_MS > 0) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    return totalModified;
  } catch (error) {
    throw new Error(
      `Failed to batch reset Meili flags for collection '${collection.collectionName}' after processing ${totalModified} documents: ${error.message}`,
    );
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
};
