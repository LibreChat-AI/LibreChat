const jwt = require('jsonwebtoken');
const cookies = require('cookie');
const crypto = require('node:crypto');
const openIdClient = require('openid-client');
const api = require('@librechat/api');
const { logger, DEFAULT_REFRESH_TOKEN_EXPIRY } = require('@librechat/data-schemas');
const { upsertSession, deleteSession } = require('~/models');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const bridge = require('./RefreshTokenBridge');
const flight = require('./OpenIDRefreshFlight');

module.exports = api.createOpenIDSessionRefreshService({
  jwt,
  cookies,
  crypto,
  openIdClient,
  logger,
  defaultRefreshTokenExpiry: DEFAULT_REFRESH_TOKEN_EXPIRY,
  isEnabled: api.isEnabled,
  math: api.math,
  createAuthIdentityContext: api.createAuthIdentityContext,
  isOpenIDSessionIdentityMatch: api.isOpenIDSessionIdentityMatch,
  createOpenIDRefreshIdentityTuple: api.createOpenIDRefreshIdentityTuple,
  createRefreshTokenBridgeIdentity: api.createRefreshTokenBridgeIdentity,
  serializeAuthIdentityTuple: api.serializeAuthIdentityTuple,
  buildOpenIDRefreshParams: api.buildOpenIDRefreshParams,
  setRefreshTokenCookie: api.setRefreshTokenCookie,
  setOpenIDMarkerCookies: api.setOpenIDMarkerCookies,
  storeOpenIdSession: api.storeOpenIdSession,
  normalizeExpiresIn: api.normalizeExpiresIn,
  upsertSession,
  deleteSession,
  getOpenIdConfig,
  OPENID_REFRESH_BRIDGE_GRACE_MS: bridge.OPENID_REFRESH_BRIDGE_GRACE_MS,
  storeRefreshTokenBridge: bridge.storeRefreshTokenBridge,
  deleteRefreshTokenBridges: bridge.deleteRefreshTokenBridges,
  acquireOpenIDRefreshFlight: flight.acquireOpenIDRefreshFlight,
  assertOpenIDRefreshFlightAvailable: flight.assertOpenIDRefreshFlightAvailable,
  assertOpenIDRefreshSessionGenerationAvailable:
    flight.assertOpenIDRefreshSessionGenerationAvailable,
  completeOpenIDRefreshFlight: flight.completeOpenIDRefreshFlight,
  createOpenIDRefreshFlightKey: flight.createOpenIDRefreshFlightKey,
  createRefreshTokenBridgeFlightKey: bridge.createRefreshTokenBridgeFlightKey,
  failOpenIDRefreshFlight: flight.failOpenIDRefreshFlight,
  waitForOpenIDRefreshFlight: flight.waitForOpenIDRefreshFlight,
  withOpenIDRefreshFlightLease: flight.withOpenIDRefreshFlightLease,
});
