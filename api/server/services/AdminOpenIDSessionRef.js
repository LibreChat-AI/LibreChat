const { CacheKeys } = require('librechat-data-provider');
const { logger, DEFAULT_REFRESH_TOKEN_EXPIRY } = require('@librechat/data-schemas');
const {
  math,
  rememberAdminOpenIDSessionRef: remember,
  recallAdminOpenIDSessionRef: recall,
  rotateAdminOpenIDSessionRef: rotate,
} = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');
const openIdSessions = require('./OpenIDSessions');

function options() {
  return {
    enforcement: openIdSessions.sessionAuthorizationRef.enforcement === true,
    ttlMs: math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY),
  };
}

function deps() {
  return { cache: getLogStores(CacheKeys.ADMIN_OPENID_SESSION_REF), logger };
}

async function rememberAdminOpenIDSessionRef(refreshToken, openidSessionId) {
  return remember(deps(), refreshToken, openidSessionId, options());
}

async function recallAdminOpenIDSessionRef(refreshToken) {
  return recall(deps(), refreshToken, options());
}

async function rotateAdminOpenIDSessionRef(oldRefreshToken, newRefreshToken, openidSessionId) {
  return rotate(deps(), oldRefreshToken, newRefreshToken, openidSessionId, options());
}

module.exports = {
  rememberAdminOpenIDSessionRef,
  recallAdminOpenIDSessionRef,
  rotateAdminOpenIDSessionRef,
};
