'use strict';

const { DEK_NAMES } = require('../deks');

/**
 * Wave 1 — auth & credential fields.
 * sessions.refreshTokenHash uses Deterministic (equality lookup during token validation).
 */
module.exports = {
  version: 1,
  description: 'Wave 1: credentials — sessions.refreshTokenHash, keys.value',
  fields: [
    { collection: 'sessions', field: 'refreshTokenHash', bsonType: 'string', dek: DEK_NAMES.SESSIONS, algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic' },
    { collection: 'keys',     field: 'value',            bsonType: 'string', dek: DEK_NAMES.KEYS,     algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' },
  ],
};

