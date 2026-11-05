const { logger } = require('@librechat/data-schemas');
const { createOpenIDBackchannelLogoutRuntime } = require('@librechat/api');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const openIdSessions = require('./OpenIDSessions');

const runtime = createOpenIDBackchannelLogoutRuntime({
  getOpenIdConfig,
  connectOpenIDAuthorization: openIdSessions.connectOpenIDAuthorization,
  getAuthorizationMethods: openIdSessions.getAuthorizationMethods,
  getLeaseMethods: openIdSessions.getLeaseMethods,
  logger,
});

module.exports = {
  initOpenIDBackchannelLogout: runtime.initOpenIDBackchannelLogout,
  startOpenIDBackchannelLogoutWorker: runtime.startOpenIDBackchannelLogoutWorker,
  getBodyParser: runtime.getBodyParser,
  getRateLimiter: runtime.getRateLimiter,
  getReceiver: runtime.getReceiver,
  createRouteMiddleware: runtime.createRouteMiddleware,
};
