const client = require('openid-client');
const { logger, runAsTenant, DEFAULT_REFRESH_TOKEN_EXPIRY } = require('@librechat/data-schemas');
const {
  math,
  limiterCache,
  removePorts,
  createOpenIDCheckLimiter,
  standardCache,
  createOpenIDCheckProvider,
  createOpenIDCheckCleanup,
  createOpenIDSessionCheck,
} = require('@librechat/api');
const { getOpenIdConfig } = require('~/strategies');
const { getAppConfig } = require('./Config');
const { clearOpenIDAuthTokens } = require('./AuthService');
const { revokeOpenIDRefreshTokenChain } = require('./OpenIDRefreshRecovery');
const { deleteRefreshTokenBridges } = require('./RefreshTokenBridge');
const { deleteSession } = require('~/models');

module.exports = createOpenIDSessionCheck({
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  cache: standardCache('OPENID_SESSION_CHECK', undefined, undefined, { throwOnErrors: true }),
  getConfig: () => getAppConfig({ baseOnly: true }),
  limiter: createOpenIDCheckLimiter({
    getConfig: () => getAppConfig({ baseOnly: true }),
    store: limiterCache('openid_session_check_limiter'),
    removePorts,
    clientDomain: process.env.DOMAIN_CLIENT,
  }),
  clientDomain: process.env.DOMAIN_CLIENT,
  serverDomain: process.env.DOMAIN_SERVER,
  provider: createOpenIDCheckProvider(
    client,
    getOpenIdConfig,
    `${process.env.DOMAIN_SERVER}${process.env.OPENID_CALLBACK_URL}`,
  ),
  ...createOpenIDCheckCleanup({
    runAsTenant,
    revokeOpenIDRefreshTokenChain,
    deleteRefreshTokenBridges,
    deleteSession,
    clearOpenIDAuthTokens,
    ttl: math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY),
  }),
  observe: (event) => logger.info('[OpenID session check]', event),
});
