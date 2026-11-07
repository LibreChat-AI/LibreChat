const { logger } = require('@librechat/data-schemas');
const { createProviderSessionService } = require('@librechat/api');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const { getAppConfig } = require('~/server/services/Config');
const {
  establishProviderSession,
  authorizeProviderSession,
  revokeProviderSession,
} = require('~/models');

const {
  getProviderSessionAuthorizer,
  getBackchannelLogoutConfig,
  preloadBackchannelLogoutConfig,
  getProviderSessionClient,
  revokeProviderSession: revokeProviderSessionService,
  providerSessionAuthorizer,
} = createProviderSessionService({
  methods: {
    establish: establishProviderSession,
    authorize: authorizeProviderSession,
    revoke: revokeProviderSession,
  },
  getAppConfig,
  getOpenIdClient: getOpenIdConfig,
  logger,
});

module.exports = {
  getProviderSessionAuthorizer,
  getBackchannelLogoutConfig,
  preloadBackchannelLogoutConfig,
  getProviderSessionClient,
  revokeProviderSession: revokeProviderSessionService,
  providerSessionAuthorizer,
};
