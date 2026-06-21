'use strict';

const { ClientEncryption, MongoClient } = require('mongodb');
const { logger } = require('@librechat/data-schemas');
const { buildKmsProviders } = require('./provider');
const { DEK_NAMES } = require('./deks');

/**
 * Bootstraps the __keyVault collection and creates the 6 DEKs idempotently.
 * Safe to call on every startup — existing DEKs are detected by alt-name and skipped.
 *
 * @param {string} mongoUri
 * @param {string} keyVaultNamespace  e.g. "LibreChat.__keyVault"
 * @returns {Promise<void>}
 */
async function bootstrapKeyVault(mongoUri, keyVaultNamespace) {
  const { kmsProviders, provider, masterKey } = buildKmsProviders();

  const client = new MongoClient(mongoUri);
  try {
    await client.connect();

    const [dbName, collName] = keyVaultNamespace.split('.');
    const keyVaultColl = client.db(dbName).collection(collName);

    await keyVaultColl.createIndex(
      { keyAltNames: 1 },
      { unique: true, partialFilterExpression: { keyAltNames: { $exists: true } } },
    );

    const encryption = new ClientEncryption(client, { keyVaultNamespace, kmsProviders });

    for (const altName of Object.values(DEK_NAMES)) {
      const existing = await encryption.getKeyByAltName(altName);
      if (existing) {
        logger.debug(`[CSFLE init] DEK already exists: ${altName}`);
        continue;
      }
      const dataKeyOptions = { keyAltNames: [altName] };
      if (masterKey) dataKeyOptions.masterKey = masterKey;
      await encryption.createDataKey(provider, dataKeyOptions);
      logger.info(`[CSFLE init] Created DEK: ${altName}`);
    }
  } finally {
    await client.close();
  }
}

module.exports = { bootstrapKeyVault };
