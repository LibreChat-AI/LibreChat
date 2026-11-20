'use strict';

const { DEK_NAMES } = require('./deks');

/**
 * Complete set of CSFLE-encrypted fields.
 * Scope: messages collection only — text and content.
 *
 * Both use Random encryption (no equality lookups on these fields).
 */
const ENCRYPTED_FIELDS = Object.freeze([
  {
    collection: 'messages',
    field: 'text',
    bsonType: 'string',
    dek: DEK_NAMES.MESSAGES,
    algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random',
  },
  {
    collection: 'messages',
    field: 'content',
    bsonType: 'array',
    dek: DEK_NAMES.MESSAGES,
    algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random',
  },
]);

/**
 * Builds the MongoDB schemaMap for autoEncryption from ENCRYPTED_FIELDS.
 *
 * @param {Record<string, import('bson').Binary>} dekIds  Alt-name → Binary UUID.
 * @param {string} dbName  MongoDB database name.
 * @returns {object} schemaMap for AutoEncryptionOptions.
 */
function buildSchemaMap(dekIds, dbName) {
  const map = {};
  for (const { collection, field, bsonType, dek, algorithm } of ENCRYPTED_FIELDS) {
    const ns = `${dbName}.${collection}`;
    if (!map[ns]) map[ns] = { bsonType: 'object', properties: {} };
    map[ns].properties[field] = {
      encrypt: { keyId: [dekIds[dek]], bsonType, algorithm },
    };
  }
  return map;
}

module.exports = { ENCRYPTED_FIELDS, buildSchemaMap };
