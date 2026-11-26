const jwt = require('jsonwebtoken');
const cookies = require('cookie');
const api = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { deleteSession, findUser } = require('~/models');
const { getOpenIdConfig, getOpenIdEmail } = require('~/strategies');
const {
  clearOpenIDAuthTokens,
  getOpenIDAppAuthToken,
  setOpenIDAuthTokens,
  storeOpenIDSession,
} = require('./AuthService');
const bridge = require('./RefreshTokenBridge');
const flight = require('./OpenIDRefreshFlight');
const { refreshOpenIDSession } = require('./OpenIDSessionRefresh');

module.exports = api.createOpenIDRefreshRecoveryService({
  jwt,
  cookies,
  getJwtRefreshSecret: () => process.env.JWT_REFRESH_SECRET,
  logger,
  findOpenIDUser: api.findOpenIDUser,
  findUser,
  getOpenIdConfig,
  getOpenIdEmail,
  getOpenIdIssuer: api.getOpenIdIssuer,
  createAuthIdentityContext: api.createAuthIdentityContext,
  refreshOpenIDSession,
  storeOpenIDSession,
  setOpenIDAuthTokens,
  clearOpenIDAuthTokens,
  getOpenIDAppAuthToken,
  deleteOpenIDSession: (refreshToken) => deleteSession({ refreshToken }),
  createRefreshTokenBridgeFlightKey: bridge.createRefreshTokenBridgeFlightKey,
  createOpenIDRefreshFlightKey: flight.createOpenIDRefreshFlightKey,
  storeRefreshTokenBridge: bridge.storeRefreshTokenBridge,
  deleteRefreshTokenBridges: bridge.deleteRefreshTokenBridges,
  acquireOpenIDRefreshFlight: flight.acquireOpenIDRefreshFlight,
  completeOpenIDRefreshFlight: flight.completeOpenIDRefreshFlight,
  failOpenIDRefreshFlight: flight.failOpenIDRefreshFlight,
  waitForOpenIDRefreshFlight: flight.waitForOpenIDRefreshFlight,
  assertOpenIDRefreshFlightAvailable: flight.assertOpenIDRefreshFlightAvailable,
  assertOpenIDRefreshSessionGenerationAvailable:
    flight.assertOpenIDRefreshSessionGenerationAvailable,
  revokeOpenIDRefreshFlights: flight.revokeOpenIDRefreshFlights,
  withOpenIDRefreshFlightLease: flight.withOpenIDRefreshFlightLease,
  bridgeGraceMs: bridge.OPENID_REFRESH_BRIDGE_GRACE_MS,
});
