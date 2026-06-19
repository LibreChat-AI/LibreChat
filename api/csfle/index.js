'use strict';

const { logger } = require('@librechat/data-schemas');
const { buildKmsProviders } = require('./provider');
const { buildSchemaFromPolicies } = require('./policies');
const { bootstrapKeyVault } = require('./init');
const { MongoClient } = require('mongodb');
const { DEK_NAMES } = require('./deks');

let cachedOptions = null;

/**
 * Builds (and caches) the autoEncryption options for MongoClient / Mongoose.
 * On first call: bootstraps __keyVault + DEKs, then fetches DEK IDs.
 *
 * @param {string} mongoUri
 * @returns {Promise<import('mongodb').AutoEncryptionOptions>}
 */
async function buildAutoEncryptionOptions(mongoUri) {
  if (cachedOptions) return cachedOptions;

  const { kmsProviders } = buildKmsProviders();

  const dbName = new URL(mongoUri).pathname.replace(/^\//, '') || 'LibreChat';
  const keyVaultNamespace =
    process.env.MONGO_CSFLE_KEY_VAULT_NAMESPACE || `${dbName}.__keyVault`;

  await bootstrapKeyVault(mongoUri, keyVaultNamespace);

  const rawClient = new MongoClient(mongoUri);
  let dekIds;
  try {
    await rawClient.connect();
    const [kvDb, kvColl] = keyVaultNamespace.split('.');
    const keyVaultColl = rawClient.db(kvDb).collection(kvColl);

    dekIds = {};
    for (const altName of Object.values(DEK_NAMES)) {
      const doc = await keyVaultColl.findOne({ keyAltNames: altName });
      if (!doc) throw new Error(`[CSFLE] DEK not found in key vault: ${altName}`);
      dekIds[altName] = doc._id;
    }
  } finally {
    await rawClient.close();
  }

  const schemaMap = buildSchemaFromPolicies(dekIds, dbName);

  const opts = {
    keyVaultNamespace,
    kmsProviders,
    schemaMap,
  };

  const cryptSharedPath = process.env.MONGO_CRYPT_SHARED_LIB_PATH;
  if (cryptSharedPath) {
    opts.extraOptions = { cryptSharedLibPath: cryptSharedPath };
  } else {
    const mongocryptdURI = process.env.MONGOCRYPTD_URI;
    const bypassSpawn = process.env.MONGOCRYPTD_BYPASS_SPAWN === 'true';
    if (mongocryptdURI || bypassSpawn) {
      opts.extraOptions = {};
      if (mongocryptdURI) opts.extraOptions.mongocryptdURI = mongocryptdURI;
      if (bypassSpawn) opts.extraOptions.mongocryptdBypassSpawn = true;
    }
    logger.warn('[CSFLE] MONGO_CRYPT_SHARED_LIB_PATH not set — falling back to mongocryptd');
  }

  cachedOptions = opts;
  return opts;
}

module.exports = { buildAutoEncryptionOptions };
