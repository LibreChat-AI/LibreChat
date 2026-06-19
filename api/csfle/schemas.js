'use strict';

const { buildSchemaFromPolicies } = require('./policies');

/**
 * Builds the schemaMap from the versioned policy registry.
 * Called by buildAutoEncryptionOptions() in index.js.
 *
 * @param {Record<string, import('bson').Binary>} dekIds
 * @param {string} dbName
 * @returns {object}
 */
function buildEncryptedFieldsMap(dekIds, dbName) {
  return buildSchemaFromPolicies(dekIds, dbName);
}

module.exports = { buildEncryptedFieldsMap };
