const { logger, runAsSystem } = require('@librechat/data-schemas');
const { createBackchannelLogoutHandlers, math, getHttpsProxyAgent } = require('@librechat/api');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const {
  getBackchannelLogoutConfig,
  getProviderSessionClient,
  revokeProviderSession,
} = require('~/server/services/ProviderSession');

const { requireBackchannelLogoutEnabled, parseBackchannelLogoutBody, handleBackchannelLogout } =
  createBackchannelLogoutHandlers({
    getConfig: getBackchannelLogoutConfig,
    getClient: getProviderSessionClient,
    getJwksUri: () => getOpenIdConfig().serverMetadata().jwks_uri,
    getCacheMaxAgeMs: () => math(process.env.OPENID_JWKS_URL_CACHE_TIME, 60000),
    getRequestAgent: getHttpsProxyAgent,
    revokeProviderSession: (data) => runAsSystem(() => revokeProviderSession(data)),
    logger,
  });

module.exports = {
  requireBackchannelLogoutEnabled,
  parseBackchannelLogoutBody,
  handleBackchannelLogout,
};
