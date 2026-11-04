const { startOpenIDAuthorization: startOpenIDSessionAuthorization } = require('@librechat/api');
const OpenIDSessions = require('./OpenIDSessions');
const OpenIDBackchannelLogout = require('./OpenIDBackchannelLogout');

/** Mounted ahead of the global body parsers and session middleware: Auth0 posts this
 *  server-to-server with its own 8 KB body limit, no session, and no CSRF check. */
async function startOpenIDAuthorization(app, appConfig) {
  app.post('/oauth/openid/backchannel-logout', ...OpenIDBackchannelLogout.createRouteMiddleware());
  await startOpenIDSessionAuthorization({
    appConfig,
    sessions: OpenIDSessions,
    backchannel: OpenIDBackchannelLogout,
  });
}

module.exports = { startOpenIDAuthorization };
