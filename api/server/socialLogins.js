const passport = require('passport');
const session = require('express-session');
const { CacheKeys } = require('librechat-data-provider');
const {
  math,
  isEnabled,
  shouldUseSecureCookie,
  registerOpenIdWithRetry,
} = require('@librechat/api');
const { logger, DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
const {
  openIdJwtLogin,
  facebookLogin,
  facebookAdminLogin,
  discordLogin,
  discordAdminLogin,
  setupOpenId,
  googleLogin,
  googleAdminLogin,
  githubLogin,
  githubAdminLogin,
  appleLogin,
  appleAdminLogin,
  setupSaml,
} = require('~/strategies');
const { getLogStores } = require('~/cache');

const DEFAULT_OPENID_REUSE_MAX_SESSION_AGE_MS = 15 * 60 * 1000;
const getSessionExpiry = () => math(process.env.SESSION_EXPIRY, DEFAULT_SESSION_EXPIRY);

const getOpenIdSessionExpiry = () => {
  const sessionExpiry = getSessionExpiry();
  if (!isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    return sessionExpiry;
  }

  const reuseMaxSessionAge = math(
    process.env.OPENID_REUSE_MAX_SESSION_AGE_MS,
    DEFAULT_OPENID_REUSE_MAX_SESSION_AGE_MS,
  );
  return Math.max(sessionExpiry, reuseMaxSessionAge);
};

/**
 * Configures OpenID Connect for the application.
 * @param {Express.Application} app - The Express application instance.
 * @param {AppConfig} [appConfig] - Base app config, read for OpenID discovery retry settings.
 * @returns {Promise<void>}
 */
async function configureOpenId(app, appConfig) {
  logger.info('Configuring OpenID Connect...');
  const sessionExpiry = getOpenIdSessionExpiry();
  const sessionOptions = {
    secret: process.env.OPENID_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: getLogStores(CacheKeys.OPENID_SESSION),
    cookie: {
      maxAge: sessionExpiry,
      secure: shouldUseSecureCookie(),
    },
  };
  app.use(session(sessionOptions));
  app.use(passport.session());

  await registerOpenIdWithRetry({
    setupOpenId,
    registerJwtStrategy: (config) => passport.use('openidJwt', openIdJwtLogin(config)),
    reuseTokens: isEnabled(process.env.OPENID_REUSE_TOKENS),
    discovery: appConfig?.registration?.openidDiscovery,
    env: {
      startupAttempts: process.env.OPENID_DISCOVERY_RETRY_ATTEMPTS,
      retryDelayMs: process.env.OPENID_DISCOVERY_RETRY_DELAY_MS,
    },
  });
}

/**
 *
 * @param {Express.Application} app
 * @param {AppConfig} [appConfig] - Base app config, read for the social login state lifetime.
 */
const configureSocialLogins = async (app, appConfig) => {
  logger.info('Configuring social logins...');
  const stateOptions = {
    secret: process.env.JWT_SECRET,
    secureCookie: shouldUseSecureCookie(),
    maxAgeMs: appConfig?.registration?.oauthStateTtlMs,
  };

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(googleLogin(stateOptions));
    passport.use('googleAdmin', googleAdminLogin());
  }
  if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
    passport.use(facebookLogin(stateOptions));
    passport.use('facebookAdmin', facebookAdminLogin());
  }
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(githubLogin(stateOptions));
    passport.use('githubAdmin', githubAdminLogin());
  }
  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    passport.use(discordLogin(stateOptions));
    passport.use('discordAdmin', discordAdminLogin());
  }
  if (process.env.APPLE_CLIENT_ID && process.env.APPLE_PRIVATE_KEY_PATH) {
    passport.use(appleLogin(stateOptions));
    passport.use('appleAdmin', appleAdminLogin());
  }
  if (
    process.env.OPENID_CLIENT_ID &&
    (isEnabled(process.env.OPENID_USE_PKCE) || process.env.OPENID_CLIENT_SECRET?.trim()) &&
    process.env.OPENID_ISSUER &&
    process.env.OPENID_SCOPE &&
    process.env.OPENID_SESSION_SECRET
  ) {
    await configureOpenId(app, appConfig);
  }
  if (
    process.env.SAML_ENTRY_POINT &&
    process.env.SAML_ISSUER &&
    process.env.SAML_CERT &&
    process.env.SAML_SESSION_SECRET
  ) {
    logger.info('Configuring SAML Connect...');
    const sessionExpiry = getSessionExpiry();
    const sessionOptions = {
      secret: process.env.SAML_SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: getLogStores(CacheKeys.SAML_SESSION),
      cookie: {
        maxAge: sessionExpiry,
        secure: shouldUseSecureCookie(),
      },
    };
    app.use(session(sessionOptions));
    app.use(passport.session());
    setupSaml();

    logger.info('SAML Connect configured.');
  }
};

module.exports = configureSocialLogins;
