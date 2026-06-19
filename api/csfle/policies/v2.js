'use strict';

const { DEK_NAMES } = require('../deks');

/**
 * Wave 2 — content/privacy fields.
 * ⚠️  Enabling this wave makes messages.text, messages.content, and
 *     conversations.title unindexable by MeiliSearch.
 *     nos-gpt-apps must clear MEILI_HOST before activating Wave 2.
 */
module.exports = {
  version: 2,
  description: 'Wave 2: content/privacy — messages, conversations',
  fields: [
    { collection: 'messages',      field: 'text',    bsonType: 'string', dek: DEK_NAMES.MESSAGES, algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' },
    { collection: 'messages',      field: 'content', bsonType: 'array',  dek: DEK_NAMES.MESSAGES, algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' },
    { collection: 'conversations', field: 'title',   bsonType: 'string', dek: DEK_NAMES.CONVOS,   algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' },
  ],
};
