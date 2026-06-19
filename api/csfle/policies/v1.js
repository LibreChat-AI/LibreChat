'use strict';

const { DEK_NAMES } = require('../deks');

/**
 * Wave 1 — auth-critical fields.
 * Deterministic algorithm is required for fields queried with equality (login lookups).
 * Random algorithm is used for fields that are only read, never queried.
 */
module.exports = {
  version: 1,
  description: 'Wave 1: auth-critical PII — users, sessions, keys',
  fields: [
    { collection: 'users', field: 'email',     bsonType: 'string', dek: DEK_NAMES.USERS,    algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic' },
    { collection: 'users', field: 'openidId',  bsonType: 'string', dek: DEK_NAMES.USERS,    algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic' },
    { collection: 'users', field: 'googleId',  bsonType: 'string', dek: DEK_NAMES.USERS,    algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic' },
    { collection: 'users', field: 'name',      bsonType: 'string', dek: DEK_NAMES.USERS,    algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' },
    { collection: 'sessions', field: 'refreshTokenHash', bsonType: 'string', dek: DEK_NAMES.SESSIONS, algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic' },
    { collection: 'keys',  field: 'value',     bsonType: 'string', dek: DEK_NAMES.KEYS,     algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' },
  ],
};
