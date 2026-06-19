'use strict';

const crypto = require('crypto');
const v1 = require('./v1');
const v2 = require('./v2');
const v3 = require('./v3');

/**
 * Ordered list of all migration policies.
 * Add new policies here — never remove or reorder existing entries.
 */
const POLICIES = Object.freeze([v1, v2, v3]);

/**
 * Returns all policies whose version is ≤ targetVersion.
 * Passing null / undefined returns all policies.
 *
 * @param {number | null} targetVersion
 * @returns {readonly object[]}
 */
function getPoliciesUpTo(targetVersion) {
  if (targetVersion == null) return POLICIES;
  return POLICIES.filter((p) => p.version <= targetVersion);
}

/**
 * Computes a short stable checksum of a policy's field definitions.
 * Used to detect whether a previously-applied policy has been mutated
 * (which would be a dangerous production mistake).
 *
 * @param {object} policy
 * @returns {string} 16-hex-char SHA-256 prefix
 */
function computeChecksum(policy) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(policy.fields))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Builds the MongoDB schemaMap for autoEncryption from ALL policies.
 *
 * The schemaMap must include every encrypted field regardless of which
 * migration waves have been applied — new writes must always be encrypted
 * even if existing documents have not yet been back-filled.
 *
 * @param {Record<string, import('bson').Binary>} dekIds
 *   Map from DEK alt-name to Binary UUID from the key vault.
 * @param {string} dbName  MongoDB database name.
 * @returns {object} schemaMap for AutoEncryptionOptions.
 */
function buildSchemaFromPolicies(dekIds, dbName) {
  const map = {};

  for (const policy of POLICIES) {
    for (const { collection, field, bsonType, dek, algorithm } of policy.fields) {
      const ns = `${dbName}.${collection}`;
      if (!map[ns]) {
        map[ns] = { bsonType: 'object', properties: {} };
      }
      map[ns].properties[field] = {
        encrypt: { keyId: [dekIds[dek]], bsonType, algorithm },
      };
    }
  }

  return map;
}

/**
 * Returns a map of collection name → array of field names for a given policy.
 * Used by the migration manager to know which fields to backfill.
 *
 * @param {object} policy
 * @returns {Record<string, string[]>}
 */
function getCollectionFields(policy) {
  const result = {};
  for (const { collection, field } of policy.fields) {
    if (!result[collection]) result[collection] = [];
    result[collection].push(field);
  }
  return result;
}

module.exports = { POLICIES, getPoliciesUpTo, computeChecksum, buildSchemaFromPolicies, getCollectionFields };
