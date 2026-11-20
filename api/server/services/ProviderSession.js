const { logger } = require('@librechat/data-schemas');
const { createProviderSessionService } = require('@librechat/api');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const { getAppConfig } = require('~/server/services/Config');
const { storeOpenIDSession } = require('~/server/services/AuthService');
const {
  establishProviderSession,
  authorizeProviderSession,
  revokeProviderSession,
} = require('~/models');

const {
  getProviderSessionAuthorizer,
  getBackchannelLogoutConfig,
  initializeBackchannelLogoutConfig,
  getProviderSessionClient,
  revokeProviderSession: revokeProviderSessionService,
  providerSessionAuthorizer,
  establishOAuthCallback,
  persistOAuthAdminBinding,
} = createProviderSessionService({
  methods: {
    establish: establishProviderSession,
    authorize: authorizeProviderSession,
    revoke: revokeProviderSession,
  },
  getAppConfig,
  getOpenIdClient: getOpenIdConfig,
  getClientId: () => process.env.OPENID_CLIENT_ID,
  storeOpenIDSession,
  logger,
});

module.exports = {
  getProviderSessionAuthorizer,
  getBackchannelLogoutConfig,
  initializeBackchannelLogoutConfig,
  getProviderSessionClient,
  revokeProviderSession: revokeProviderSessionService,
  providerSessionAuthorizer,
  establishOAuthCallback,
  persistOAuthAdminBinding,
};
