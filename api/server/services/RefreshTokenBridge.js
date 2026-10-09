const {
  createRefreshTokenBridgeIdentity,
  createRefreshTokenBridgeService,
  math,
} = require('@librechat/api');
const {
  logger,
  encryptV2,
  decryptV2,
  DEFAULT_REFRESH_TOKEN_EXPIRY,
} = require('@librechat/data-schemas');
const db = require('~/models');

module.exports = createRefreshTokenBridgeService({
  db,
  logger,
  encrypt: encryptV2,
  decrypt: decryptV2,
  math,
  defaultRefreshTokenExpiry: DEFAULT_REFRESH_TOKEN_EXPIRY,
  createIdentity: createRefreshTokenBridgeIdentity,
});
