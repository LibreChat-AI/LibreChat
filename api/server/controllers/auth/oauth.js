const { CacheKeys } = require('librechat-data-provider');
const { logger, DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
const {
  isEnabled,
  getAdminPanelUrl,
  isAdminPanelRedirect,
  generateAdminExchangeCode,
} = require('@librechat/api');
const { syncUserEntraGroupMemberships } = require('~/server/services/PermissionService');
const { setAuthTokens } = require('~/server/services/AuthService');
const { sendOpenIDAuthResponse } = require('~/server/services/OpenIDRefreshRecovery');
const getLogStores = require('~/cache/getLogStores');
const { checkBan } = require('~/server/middleware');
const { generateToken } = require('~/models');

const domains = {
  client: process.env.DOMAIN_CLIENT,
  server: process.env.DOMAIN_SERVER,
};

function createOAuthHandler(redirectUri = domains.client) {
  /**
   * A handler to process OAuth authentication results.
   * @type {Function}
   * @param {ServerRequest} req - Express request object.
   * @param {ServerResponse} res - Express response object.
   * @param {NextFunction} next - Express next middleware function.
   */
  return async (req, res, next) => {
    try {
      if (res.headersSent) {
        return;
      }

      await checkBan(req, res);
      if (req.banned) {
        return;
      }

      /** Check if this is an admin panel redirect (cross-origin or same-origin subpath) */
      if (isAdminPanelRedirect(redirectUri, getAdminPanelUrl(), domains.client)) {
        /** For admin panel, generate exchange code instead of setting cookies */
        const cache = getLogStores(CacheKeys.ADMIN_OAUTH_EXCHANGE);
        const sessionExpiry = Number(process.env.SESSION_EXPIRY) || DEFAULT_SESSION_EXPIRY;
        const token = await generateToken(req.user, sessionExpiry);

        let refreshToken;
        if (req.user.provider === 'openid') {
          if (isEnabled(process.env.OPENID_REUSE_TOKENS) === true) {
            refreshToken =
              req.user.tokenset?.refresh_token || req.user.federatedTokens?.refresh_token;
          }
        } else if (req.user.provider === 'google') {
          refreshToken = req.authInfo?.refreshToken;
        }
        const expiresAt = Date.now() + sessionExpiry;

        const callbackUrl = new URL(redirectUri);
        const exchangeCode = await generateAdminExchangeCode(
          cache,
          req.user,
          token,
          refreshToken,
          callbackUrl.origin,
          req.pkceChallenge,
          expiresAt,
        );
        callbackUrl.searchParams.set('code', exchangeCode);
        logger.info(`[OAuth] Admin panel redirect with exchange code for user: ${req.user.email}`);
        return res.redirect(callbackUrl.toString());
      }

      /** Standard OAuth flow - set cookies and redirect */
      if (
        req.user &&
        req.user.provider == 'openid' &&
        isEnabled(process.env.OPENID_REUSE_TOKENS) === true
      ) {
        await syncUserEntraGroupMemberships(req.user, req.user.tokenset.access_token);
        await sendOpenIDAuthResponse({
          tokenset: req.user.tokenset,
          user: req.user,
          existingRefreshToken: req.user.tokenset.refresh_token,
          openidSubject: req.user.openidId,
          openidIssuer: req.user.openidIssuer,
          discardSessionTokens: true,
          req,
          res,
        });
      } else {
        await setAuthTokens(req.user._id, res, null, req);
        if (
          req.user.provider === 'openid' &&
          isEnabled(process.env.OPENID_USE_END_SESSION_ENDPOINT)
        ) {
          req.session.openidLogoutIdToken = req.user.tokenset?.id_token;
        }
      }
      res.redirect(redirectUri);
    } catch (err) {
      logger.error('Error in setting authentication tokens:', err);
      next(err);
    }
  };
}

module.exports = {
  createOAuthHandler,
};
