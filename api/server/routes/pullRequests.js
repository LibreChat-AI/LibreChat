const { createProxyAwareFetch, createPullRequestConnectionRouter } = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { markOAuthNavigation } = require('~/server/middleware/oauthNavigation');
const { loginLimiter } = require('~/server/middleware/limiters');
const { getAppConfig } = require('~/server/services/Config');
const db = require('~/models');

module.exports = createPullRequestConnectionRouter({
  store: db,
  fetchFn: createProxyAwareFetch(),
  env: process.env,
  getAppConfig,
  getUserById: db.getUserById,
  requireJwtAuth,
  markNavigation: markOAuthNavigation,
  callbackLimiter: loginLimiter,
});
