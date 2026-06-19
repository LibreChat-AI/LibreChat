'use strict';

/**
 * DEK alt-name constants.  These strings are stored in __keyVault and must
 * never be renamed after initial provisioning.
 */
const DEK_NAMES = Object.freeze({
  USERS: 'dek-users',
  MESSAGES: 'dek-messages',
  CONVOS: 'dek-convos',
  KEYS: 'dek-keys',
  FILES: 'dek-files',
  SESSIONS: 'dek-sessions',
});

module.exports = { DEK_NAMES };
