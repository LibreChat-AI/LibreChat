'use strict';

/**
 * DEK alt-name constants.  These strings are stored in __keyVault and must
 * never be renamed after initial provisioning.
 */
const DEK_NAMES = Object.freeze({
  MESSAGES: 'dek-messages',
});

module.exports = { DEK_NAMES };
