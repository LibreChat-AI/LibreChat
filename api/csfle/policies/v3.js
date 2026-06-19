'use strict';

const { DEK_NAMES } = require('../deks');

/**
 * Wave 3 — completeness fields.
 * username uses Deterministic so equality lookups remain possible.
 */
module.exports = {
  version: 3,
  description: 'Wave 3: completeness — remaining user fields, files',
  fields: [
    { collection: 'users',  field: 'username', bsonType: 'string', dek: DEK_NAMES.USERS, algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic' },
    { collection: 'users',  field: 'avatar',   bsonType: 'string', dek: DEK_NAMES.USERS, algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' },
    { collection: 'files',  field: 'filename', bsonType: 'string', dek: DEK_NAMES.FILES, algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' },
    { collection: 'files',  field: 'filepath', bsonType: 'string', dek: DEK_NAMES.FILES, algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' },
  ],
};
