const cookies = require('cookie');
const { isEnabled, math, clearCloudFrontCookies } = require('@librechat/api');
const { logger, DEFAULT_REFRESH_TOKEN_EXPIRY } = require('@librechat/data-schemas');
const { logoutUser } = require('~/server/services/AuthService');
const { deleteAllRefreshTokenBridges } = require('~/server/services/RefreshTokenBridge');
const { revokeOpenIDRefreshTokenChain } = require('~/server/services/OpenIDRefreshRecovery');
const { getOpenIdConfig } = require('~/strategies');

/** Parses and validates OPENID_MAX_LOGOUT_URL_LENGTH, returning defaultValue on invalid input */
function parseMaxLogoutUrlLength(defaultValue = 2000) {
  const raw = process.env.OPENID_MAX_LOGOUT_URL_LENGTH;
  const trimmed = raw == null ? '' : raw.trim();
  if (trimmed === '') {
    return defaultValue;
  }
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `[logoutController] Invalid OPENID_MAX_LOGOUT_URL_LENGTH value "${raw}", using default ${defaultValue}`,
    );
    return defaultValue;
  }
  return parsed;
}

const logoutController = async (req, res) => {
  const parsedCookies = req.headers.cookie ? cookies.parse(req.headers.cookie) : {};
  const isOpenIdUser = req.user?.openidId != null && req.user?.provider === 'openid';

  let refreshToken;
  let idToken;
  let sessionRefreshToken;
  if (isOpenIdUser && req.session?.openidTokens) {
    sessionRefreshToken = req.session.openidTokens.refreshToken;
    idToken = req.session.openidTokens.idToken;
  }
  /** Both can name distinct durable sessions when an older browser request races rotation. */
  refreshToken = parsedCookies.refreshToken || sessionRefreshToken;
  idToken =
    idToken ||
    (isOpenIdUser ? req.session?.openidLogoutIdToken : undefined) ||
    parsedCookies.openid_id_token;
  const logoutTokens = isOpenIdUser
    ? [...new Set([parsedCookies.refreshToken, sessionRefreshToken].filter(Boolean))]
    : [refreshToken];

  try {
    if (isOpenIdUser) {
      const userId = req.user?.id ?? req.user?._id?.toString?.();
      const refreshIdentity = {
        appUserId: userId,
        openidSubject: req.session?.openidTokens?.openidSubject ?? req.user?.openidId,
        tenantId: req.session?.openidTokens?.tenantId ?? req.user?.tenantId,
        openidIssuer: req.session?.openidTokens?.openidIssuer ?? req.user?.openidIssuer,
      };
      const revokedRefreshTokens = await revokeOpenIDRefreshTokenChain({
        req,
        user: req.user,
        identityContext: refreshIdentity,
        refreshTokens: [...logoutTokens],
        publicationKeys: [req.session?.openidTokens?.publicationFlightKey].filter(Boolean),
        ttl: math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY),
      });
      logoutTokens.push(...revokedRefreshTokens);
      await deleteAllRefreshTokenBridges({
        userId,
        tenantId: req.user?.tenantId,
      });
      if (req.session) {
        delete req.session.openidTokens;
        delete req.session.openidLogoutIdToken;
      }
    }
    if (logoutTokens.length === 0) {
      logoutTokens.push(undefined);
    }
    let logout = { status: 200, message: 'Logout successful' };
    for (const token of new Set(logoutTokens)) {
      const result = await logoutUser(req, token);
      if (result.status !== 200) {
        logout = result;
      }
    }
    const { status, message } = logout;

    res.clearCookie('refreshToken');
    res.clearCookie('openid_access_token');
    res.clearCookie('openid_id_token');
    res.clearCookie('openid_user_id');
    res.clearCookie('token_provider');
    clearCloudFrontCookies(res, {
      userId: req.user?.id ?? req.user?._id?.toString?.(),
      tenantId: req.user?.tenantId,
    });
    const response = { message };
    if (
      isOpenIdUser &&
      isEnabled(process.env.OPENID_USE_END_SESSION_ENDPOINT) &&
      process.env.OPENID_ISSUER
    ) {
      let openIdConfig;
      try {
        openIdConfig = getOpenIdConfig();
      } catch (err) {
        logger.warn('[logoutController] OpenID config not available:', err.message);
      }
      if (openIdConfig) {
        const endSessionEndpoint = openIdConfig.serverMetadata().end_session_endpoint;
        if (endSessionEndpoint) {
          const endSessionUrl = new URL(endSessionEndpoint);
          const postLogoutRedirectUri =
            process.env.OPENID_POST_LOGOUT_REDIRECT_URI || `${process.env.DOMAIN_CLIENT}/login`;
          endSessionUrl.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);

          /**
           * OIDC RP-Initiated Logout cascading strategy:
           * 1. id_token_hint (most secure, identifies exact session)
           * 2. logout_hint + client_id (when URL would exceed safe length)
           * 3. client_id only (when no token available)
           *
           * JWT tokens from spec-compliant OIDC providers use base64url
           * encoding (RFC 7515), whose characters are all URL-safe, so
           * token length equals URL-encoded length for projection.
           * Non-compliant issuers using standard base64 (+/=) will cause
           * underestimation; increase OPENID_MAX_LOGOUT_URL_LENGTH if the
           * fallback does not trigger as expected.
           */
          const maxLogoutUrlLength = parseMaxLogoutUrlLength();
          let strategy = 'no_token';
          if (idToken) {
            const baseLength = endSessionUrl.toString().length;
            const projectedLength = baseLength + '&id_token_hint='.length + idToken.length;
            if (projectedLength > maxLogoutUrlLength) {
              strategy = 'too_long';
              logger.debug(
                `[logoutController] Logout URL too long (${projectedLength} chars, max ${maxLogoutUrlLength}), ` +
                  'switching to logout_hint strategy',
              );
            } else {
              strategy = 'use_token';
            }
          }

          if (strategy === 'use_token') {
            endSessionUrl.searchParams.set('id_token_hint', idToken);
          } else {
            if (strategy === 'too_long') {
              const logoutHint = req.user?.email || req.user?.username || req.user?.openidId;
              if (logoutHint) {
                endSessionUrl.searchParams.set('logout_hint', logoutHint);
              }
            }

            if (process.env.OPENID_CLIENT_ID) {
              endSessionUrl.searchParams.set('client_id', process.env.OPENID_CLIENT_ID);
            } else if (strategy === 'too_long') {
              logger.warn(
                '[logoutController] Logout URL exceeds max length and OPENID_CLIENT_ID is not set. ' +
                  'The OIDC end-session request may be rejected. ' +
                  'Consider setting OPENID_CLIENT_ID or increasing OPENID_MAX_LOGOUT_URL_LENGTH.',
              );
            } else {
              logger.warn(
                '[logoutController] Neither id_token_hint nor OPENID_CLIENT_ID is available. ' +
                  'Sign in again to establish an OpenID session with an ID token. ' +
                  'The OIDC end-session request may be rejected by the identity provider.',
              );
            }
          }

          response.redirect = endSessionUrl.toString();
        } else {
          logger.warn(
            '[logoutController] end_session_endpoint not found in OpenID issuer metadata. Please verify that the issuer is correct.',
          );
        }
      }
    }
    return res.status(status).send(response);
  } catch (err) {
    logger.error('[logoutController]', err);
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  logoutController,
};
