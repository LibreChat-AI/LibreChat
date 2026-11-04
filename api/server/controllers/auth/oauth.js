const { CacheKeys, DEFAULT_OPENID_AUTHORIZATION_TIMEOUT_MS } = require('librechat-data-provider');
const { logger, DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
const {
  isEnabled,
  getAdminPanelUrl,
  isAdminPanelRedirect,
  generateAdminExchangeCode,
  resolveOpenIDLoginCompletion,
} = require('@librechat/api');
const { syncUserEntraGroupMemberships } = require('~/server/services/PermissionService');
const { setAuthTokens } = require('~/server/services/AuthService');
const { sendOpenIDAuthResponse } = require('~/server/services/OpenIDRefreshRecovery');
const openIdSessions = require('~/server/services/OpenIDSessions');
const getLogStores = require('~/cache/getLogStores');
const { rememberAdminOpenIDSessionRef } = require('~/server/services/AdminOpenIDSessionRef');
const { checkBan } = require('~/server/middleware');
const { generateToken } = require('~/models');

const domains = {
  client: process.env.DOMAIN_CLIENT,
  server: process.env.DOMAIN_SERVER,
};

function createOAuthHandler(redirectUri = domains.client, retryRoute = '/oauth/openid') {
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

      const isAdminExchange = isAdminPanelRedirect(redirectUri, getAdminPanelUrl(), domains.client);

      let adminRefreshToken;
      if (isAdminExchange) {
        if (req.user.provider === 'openid') {
          if (isEnabled(process.env.OPENID_REUSE_TOKENS) === true) {
            adminRefreshToken =
              req.user.tokenset?.refresh_token || req.user.federatedTokens?.refresh_token;
          }
        } else if (req.user.provider === 'google') {
          adminRefreshToken = req.authInfo?.refreshToken;
        }
      }

      const completion = await resolveOpenIDLoginCompletion(
        {
          provider: req.user?.provider,
          user: {
            id: req.user?._id?.toString(),
            tenantId: req.user?.tenantId,
            openidIssuer: req.user?.openidIssuer,
            openidId: req.user?.openidId,
          },
          tokenset: req.user?.tokenset,
          session: req.session,
          retryRoute,
          loginFailureRedirectBase: process.env.DOMAIN_CLIENT,
          isAdminExchange,
          adminRefreshToken,
        },
        {
          loginDeps: openIdSessions.getLoginDeps(),
          clientId: openIdSessions.getOpenIdClientId(),
          sessionAuthorizationEnforcement:
            openIdSessions.sessionAuthorizationRef.enforcement === true,
          sessionAuthorizationTimeoutMs:
            openIdSessions.sessionAuthorizationRef.timeoutMs ??
            DEFAULT_OPENID_AUTHORIZATION_TIMEOUT_MS,
          rememberAdminSessionRef: rememberAdminOpenIDSessionRef,
          logger,
        },
      );
      if (completion.kind === 'redirect') {
        return res.redirect(completion.url);
      }
      const { openidSessionId } = completion;

      /** Check if this is an admin panel redirect (cross-origin or same-origin subpath) */
      if (isAdminExchange) {
        /** For admin panel, generate exchange code instead of setting cookies */
        const cache = getLogStores(CacheKeys.ADMIN_OAUTH_EXCHANGE);
        const sessionExpiry = Number(process.env.SESSION_EXPIRY) || DEFAULT_SESSION_EXPIRY;

        const token = await generateToken(
          req.user,
          sessionExpiry,
          req.user.provider === 'openid'
            ? { openidSessionId, tenantId: req.user.tenantId }
            : undefined,
        );
        const expiresAt = Date.now() + sessionExpiry;

        const callbackUrl = new URL(redirectUri);
        const exchangeCode = await generateAdminExchangeCode(
          cache,
          req.user,
          token,
          adminRefreshToken,
          callbackUrl.origin,
          req.pkceChallenge,
          expiresAt,
        );
        callbackUrl.searchParams.set('code', exchangeCode);
        logger.info(`[OAuth] Admin panel redirect with exchange code for user: ${req.user._id}`);
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
          openidSessionId,
          req,
          res,
        });
      } else {
        await setAuthTokens(
          req.user._id,
          res,
          null,
          req,
          req.user.provider === 'openid'
            ? { openidSessionId, tenantId: req.user.tenantId }
            : undefined,
        );
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
