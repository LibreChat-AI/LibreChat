const { AUTH_SESSION_CHECK_UNAVAILABLE } = require('librechat-data-provider');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  receiveBackchannelLogout,
  isBackchannelLogoutEnabled,
  createLogoutJwksKeyResolver,
  createLogoutBodyParser,
  getSafeErrorMetadata,
} = require('@librechat/api');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const {
  getBackchannelLogoutConfig,
  getProviderSessionClient,
  revokeProviderSession,
} = require('~/server/services/ProviderSession');

const resolveSigningKey = createLogoutJwksKeyResolver({
  getJwksUri: () => getOpenIdConfig().serverMetadata().jwks_uri,
});

/** Falls through to the app's 404 when the feature is off or unconfigured; a failed config
 *  load answers 503 rather than reaching the default error handler. */
async function requireBackchannelLogoutEnabled(req, res, next) {
  let config;
  try {
    config = await getBackchannelLogoutConfig();
  } catch (error) {
    logger.error('[OpenIDBackchannelLogout] Config load failed', getSafeErrorMetadata(error));
    res.status(503).json({ code: AUTH_SESSION_CHECK_UNAVAILABLE });
    return;
  }
  const client = getProviderSessionClient();
  if (!isBackchannelLogoutEnabled(config, client)) {
    /** Skips the rest of this route, not just this middleware, so the request falls through to
     *  the app's ordinary 404 instead of continuing into the next handler in this route's chain. */
    next('route');
    return;
  }
  res.set('Cache-Control', 'no-store');
  req.backchannelLogout = { config, client };
  next();
}

const parseBackchannelLogoutBody = createLogoutBodyParser(
  (req) => req.backchannelLogout.config.maxBodyBytes,
);

async function handleBackchannelLogout(req, res) {
  const { config, client } = req.backchannelLogout;
  const response = await receiveBackchannelLogout(req.body?.logout_token, {
    config,
    client,
    resolveKey: resolveSigningKey,
    revokeProviderSession: (data) => runAsSystem(() => revokeProviderSession(data)),
    logger,
  });

  if (response.status === 200) {
    res.status(200).end();
    return;
  }
  res.status(response.status).json(response.body);
}

module.exports = {
  requireBackchannelLogoutEnabled,
  parseBackchannelLogoutBody,
  handleBackchannelLogout,
};
