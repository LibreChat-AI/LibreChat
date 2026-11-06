const { logger, runAsSystem } = require('@librechat/data-schemas');
const { createBackchannelLogoutHandlers } = require('@librechat/api');
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
    revokeProviderSession: (data) => runAsSystem(() => revokeProviderSession(data)),
    logger,
  });

module.exports = {
  requireBackchannelLogoutEnabled,
  parseBackchannelLogoutBody,
  handleBackchannelLogout,
};
