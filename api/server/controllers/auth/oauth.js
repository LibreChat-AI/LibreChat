const { CacheKeys } = require('librechat-data-provider');
const {
  logger,
  DEFAULT_SESSION_EXPIRY,
  DEFAULT_REFRESH_TOKEN_EXPIRY,
} = require('@librechat/data-schemas');
const {
  math,
  isEnabled,
  getAdminPanelUrl,
  isAdminPanelRedirect,
  generateAdminExchangeCode,
  establishOpenIDCallbackProviderSession,
  resolveAuthMethod,
} = require('@librechat/api');
const { syncUserEntraGroupMemberships } = require('~/server/services/PermissionService');
const { setAuthTokens, storeOpenIDSession } = require('~/server/services/AuthService');
const { sendOpenIDAuthResponse } = require('~/server/services/OpenIDRefreshRecovery');
const {
  getProviderSessionAuthorizer,
  getProviderSessionClient,
} = require('~/server/services/ProviderSession');
const getLogStores = require('~/cache/getLogStores');
const { checkBan } = require('~/server/middleware');
const { generateToken } = require('~/models');

const domains = {
  client: process.env.DOMAIN_CLIENT,
  server: process.env.DOMAIN_SERVER,
};

/** Rechecks the provider-session record before any cookie setter runs. Returns `null` for a
 *  non-OpenID login, `undefined` once `res` has already redirected on a denial. */
async function establishProviderSession(req, res) {
  if (req.user?.provider !== 'openid') {
    return null;
  }

  const result = await establishOpenIDCallbackProviderSession(
    {
      authorizer: getProviderSessionAuthorizer(),
      getProviderSessionClient,
      logger,
      refreshTokenExpiryMs: math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY),
    },
    {
      getClaims: () => req.user.tokenset.claims(),
      callbackIssuedAt: req.session?.openidLoginIssuedAt
        ? new Date(req.session.openidLoginIssuedAt)
        : undefined,
      res,
      clientDomain: domains.client,
    },
  );
  return result.ok ? result.ref : undefined;
}

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

      /** Verified before any cookie setter or exchange-code issuance; a denial or unavailable
       *  check redirects and returns `undefined` here, so the handler must stop. */
      const providerSessionRef = await establishProviderSession(req, res);
      if (providerSessionRef === undefined) {
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

        if (refreshToken && req.user.provider === 'openid') {
          const mode = await getProviderSessionAuthorizer().getMode();
          if (mode !== 'off') {
            /** So a later admin refresh can find this credential's provider-session binding. */
            await storeOpenIDSession(req.user._id, refreshToken, req.user.tenantId, undefined, {
              providerSession: providerSessionRef,
              authMethod: 'openid',
            });
          }
        }

        const callbackUrl = new URL(redirectUri);
        const exchangeCode = await generateAdminExchangeCode(
          cache,
          req.user,
          token,
          refreshToken,
          callbackUrl.origin,
          req.pkceChallenge,
          expiresAt,
          providerSessionRef,
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
          providerSession: providerSessionRef,
          req,
          res,
        });
      } else {
        await setAuthTokens(req.user._id, res, null, req, {
          providerSession: providerSessionRef,
          authMethod: resolveAuthMethod(req.user.provider),
        });
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
