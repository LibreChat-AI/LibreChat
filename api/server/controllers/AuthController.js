const cookies = require('cookie');
const jwt = require('jsonwebtoken');
const { logger, runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const {
  math,
  isEnabled,
  createResetPasswordController,
  createAuthIdentityContext,
  createOpenIDRefreshOwnershipError,
  createOpenIDResponseDelivery,
  isOpenIDRefreshOwnershipError,
  isOpenIDSessionMissingError,
  isOpenIDSessionIdentityMatch,
  OPENID_EXPIRY_BUFFER_SECONDS,
  clearCloudFrontCookies,
  createLocalRefreshHandler,
  generateTwoFactorSetupToken,
  getValidOpenIDReuseCredential,
  isTokenRetired,
  isTwoFactorEnrollmentRequired,
  getSafeErrorMetadata,
  sanitizeUserForAuthResponse,
  clearSessionHintCookie,
} = require('@librechat/api');
const {
  requestPasswordReset,
  clearOpenIDAuthTokens,
  setCloudFrontAuthCookies,
  resetPassword,
  setAuthTokens,
  registerUser,
} = require('~/server/services/AuthService');
const {
  deleteAllUserSessions,
  deletePasskeysByUser,
  awaitAuthUserDocEviction,
  deleteSession,
  getUserById,
  findSession,
  updateUser,
  deleteTokens,
} = require('~/models');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const { getRefreshTokenBridge } = require('~/server/services/RefreshTokenBridge');
const {
  recoverOpenIDRefreshBridge,
  refreshOpenIDUser,
  sendOpenIDAuthResponse,
} = require('~/server/services/OpenIDRefreshRecovery');
const OpenIDRefreshFlight = require('~/server/services/OpenIDRefreshFlight');

const AUTH_REFRESH_USER_PROJECTION = '-password -__v -totpSecret -backupCodes -federatedTokens';
/**
 * Max age (ms) LibreChat reuses a cached OpenID session token before forcing an IdP refresh.
 * Env-overridable (accepts an arithmetic expression, e.g. `60 * 60 * 24 * 1000`, like
 * `SESSION_EXPIRY`): deployments whose IdP revokes the previous access token on refresh can
 * widen this to the access-token lifetime so a still-valid token is not rotated/revoked out
 * from under downstream consumers (e.g. MCP servers that introspect the bearer). Defaults to
 * 15 minutes.
 */
const OPENID_REUSE_MAX_SESSION_AGE_MS = math(
  process.env.OPENID_REUSE_MAX_SESSION_AGE_MS,
  15 * 60 * 1000,
);

const registrationController = async (req, res) => {
  try {
    const response = await registerUser(req.body);
    const { status, message } = response;
    /** Consume the invite only once the account exists. `registerUser` returns the same
     * 200 whether it created a user or found the email already in use, so the decision
     * rests on `userCreated` rather than the status. A failure to delete leaves a
     * usable invite, which is recoverable; failing the response here would tell a user
     * whose account was just created that registration failed, which is not. */
    if (response.userCreated === true && req.invite?.token != null) {
      try {
        await deleteTokens({ token: req.invite.token });
      } catch (error) {
        logger.error(
          '[registrationController] Failed to consume invite after registration',
          getSafeErrorMetadata(error),
        );
      }
    }
    res.status(status).send({ message });
  } catch (err) {
    logger.error('[registrationController]', getSafeErrorMetadata(err));
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

const runInUserTenant = (user, fn) =>
  user.tenantId
    ? tenantStorage.run(
        { tenantId: user.tenantId, userId: user._id.toString() },
        async () => await fn(),
      )
    : runAsSystem(fn);

const selectOpenIDRefreshToken = (openidTokens, parsedCookies) => {
  const sessionRefreshToken = openidTokens?.refreshToken;
  const browserRefreshToken = parsedCookies.refreshToken;
  const lastSyncedBrowserRefreshToken = openidTokens?.browserRefreshToken;
  const hasKnownBrowserRefreshTokenMarker =
    typeof lastSyncedBrowserRefreshToken === 'string' && lastSyncedBrowserRefreshToken.length > 0;
  const driftReference = hasKnownBrowserRefreshTokenMarker
    ? lastSyncedBrowserRefreshToken
    : sessionRefreshToken;

  if (browserRefreshToken && driftReference && browserRefreshToken !== driftReference) {
    logger.info('[refreshController] OpenID refresh token cookie differs from session state');
    return {
      refreshToken: sessionRefreshToken || browserRefreshToken,
      fallbackRefreshToken:
        sessionRefreshToken && browserRefreshToken !== sessionRefreshToken
          ? browserRefreshToken
          : null,
      cookieDiffersFromSession: true,
    };
  }

  return {
    refreshToken: sessionRefreshToken || browserRefreshToken,
    fallbackRefreshToken: null,
    cookieDiffersFromSession: false,
  };
};

const isRecentOpenIDSessionRefresh = (openidTokens) => {
  const lastRefreshedAt = Number(openidTokens?.lastRefreshedAt);
  const elapsed = Date.now() - lastRefreshedAt;
  return (
    Number.isFinite(lastRefreshedAt) && elapsed >= 0 && elapsed <= OPENID_REUSE_MAX_SESSION_AGE_MS
  );
};

const isInvalidGrantError = (error) => {
  const values = [
    error?.message,
    error?.error,
    error?.code,
    error?.response?.data?.error,
    error?.response?.data?.error_description,
    error?.body?.error,
    error?.body?.error_description,
  ];

  return values.some(
    (value) => typeof value === 'string' && value.toLowerCase().includes('invalid_grant'),
  );
};

const getAuthIdentitySource = (user) =>
  typeof user?.toObject === 'function' ? user.toObject() : user;

const isReusableOpenIDSessionIdentity = (openidTokens, user) => {
  const identitySource = getAuthIdentitySource(user);
  const expectedIdentity = createAuthIdentityContext({ user: identitySource });
  const matches = isOpenIDSessionIdentityMatch(openidTokens, expectedIdentity);
  if (!matches) {
    logger.warn('[refreshController] OpenID session token identity mismatch; forcing refresh', {
      userId: expectedIdentity.appUserId,
      has_session_user_id: Boolean(openidTokens?.appUserId),
      has_session_subject: Boolean(openidTokens?.openidSubject),
      has_session_issuer: Boolean(openidTokens?.openidIssuer),
    });
  }
  return matches;
};

const getReusableOpenIDSessionToken = (openidTokens) => {
  if (!isRecentOpenIDSessionRefresh(openidTokens)) {
    return null;
  }

  const candidates = [
    { token: openidTokens?.idToken, type: 'id_token' },
    { token: openidTokens?.accessToken, type: 'access_token' },
  ];
  const now = Math.floor(Date.now() / 1000);

  for (const candidate of candidates) {
    if (!candidate.token) {
      continue;
    }
    /** Decode only: tokens are from the trusted server-side session; expiry gates reuse. */
    const decoded = jwt.decode(candidate.token);
    if (
      decoded &&
      typeof decoded === 'object' &&
      decoded.exp > now + OPENID_EXPIRY_BUFFER_SECONDS
    ) {
      return candidate;
    }
  }

  return null;
};

const withOpenIDResponseDelivery = createOpenIDResponseDelivery({
  flight: OpenIDRefreshFlight,
  logger,
});

const resetPasswordRequestController = async (req, res) => {
  try {
    const resetService = await requestPasswordReset(req);
    if (resetService instanceof Error) {
      return res.status(400).json(resetService);
    } else {
      return res.status(200).json(resetService);
    }
  } catch (e) {
    logger.error('[resetPasswordRequestController]', getSafeErrorMetadata(e));
    return res.status(400).json({ message: 'Something went wrong' });
  }
};

const resetPasswordController = createResetPasswordController({
  resetPassword,
  deleteAllUserSessions,
  deletePasskeysByUser,
  awaitAuthUserDocEviction,
});

const refreshLocalSession = createLocalRefreshHandler({
  userProjection: AUTH_REFRESH_USER_PROJECTION,
  getUserById,
  findSession,
  setAuthTokens,
  deleteAllUserSessions,
  deleteSession,
  generateTwoFactorSetupToken,
  isTwoFactorEnrollmentRequired,
  clearCloudFrontCookies,
  warn: (message) => logger.warn(message),
  error: (message, cause) => logger.error(message, cause),
});

const refreshController = async (req, res) => {
  const parsedCookies = req.headers.cookie ? cookies.parse(req.headers.cookie) : {};
  const token_provider = parsedCookies.token_provider;

  if (token_provider === 'openid' && isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    /** Prefer session refresh tokens unless the browser cookie proves the session is stale. */
    const { refreshToken, fallbackRefreshToken, cookieDiffersFromSession } =
      selectOpenIDRefreshToken(req.session?.openidTokens, parsedCookies);

    if (!refreshToken) {
      clearSessionHintCookie(res);
      return res.status(200).send('Refresh token not provided');
    }

    try {
      /**
       * Reuse skips an IdP refresh only for recently-refreshed server-side tokens.
       * Stale, missing, or near-expiry tokens fall through to refreshTokenGrant so
       * upstream revocations and cookie/session extension are checked regularly.
       */
      const reusableSessionToken = cookieDiffersFromSession
        ? null
        : getReusableOpenIDSessionToken(req.session?.openidTokens);
      const reuseCredential = reusableSessionToken
        ? getValidOpenIDReuseCredential(parsedCookies, process.env.JWT_REFRESH_SECRET)
        : null;
      const reuseUserId = reuseCredential?.userId;
      if (reuseUserId) {
        const reuseSessionTokens = req.session?.openidTokens;
        try {
          const response = await withOpenIDResponseDelivery(
            {
              res,
              openidTokens: reuseSessionTokens,
              context: 'refreshController',
            },
            async (sendAuthorized) => {
              const user = await runAsSystem(async () =>
                getUserById(reuseUserId, AUTH_REFRESH_USER_PROJECTION),
              );
              if (
                !user ||
                isTokenRetired(reuseCredential, user) ||
                !isReusableOpenIDSessionIdentity(reuseSessionTokens, user)
              ) {
                return undefined;
              }
              return sendAuthorized(() => {
                const cloudFrontCookiesSet = setCloudFrontAuthCookies(req, res, user);
                logger.debug('[refreshController] OpenID session token reused', {
                  token_type: reusableSessionToken.type,
                  has_id_token: Boolean(reuseSessionTokens?.idToken),
                  has_access_token: Boolean(reuseSessionTokens?.accessToken),
                  cloudfront_cookies_set: cloudFrontCookiesSet,
                });
                return res.status(200).send({
                  token: reusableSessionToken.token,
                  user: sanitizeUserForAuthResponse(user),
                });
              });
            },
          );
          if (response !== undefined) {
            return response;
          }
        } catch (error) {
          if (!isOpenIDRefreshOwnershipError(error)) {
            throw error;
          }
          clearOpenIDAuthTokens(req, res, reuseUserId, reuseSessionTokens?.tenantId);
          return res.status(403).send('Invalid OpenID refresh token');
        }
      }

      const refreshUserId =
        req.session?.openidTokens?.appUserId ??
        getValidOpenIDReuseCredential(parsedCookies, process.env.JWT_REFRESH_SECRET)?.userId;
      if (!refreshUserId) {
        clearSessionHintCookie(res);
        return res.status(403).send('Invalid OpenID refresh token');
      }

      const refreshUser = await runAsSystem(async () =>
        getUserById(refreshUserId, AUTH_REFRESH_USER_PROJECTION),
      );
      if (!refreshUser) {
        clearSessionHintCookie(res);
        return res.status(403).send('Invalid OpenID refresh token');
      }

      return await runInUserTenant(refreshUser, async () => {
        let successfulRefreshToken = refreshToken;
        let refreshResult;
        try {
          refreshResult = await refreshOpenIDUser({
            req,
            res,
            user: refreshUser,
            refreshToken,
            browserRefreshToken: parsedCookies.refreshToken,
            strategyName: 'refreshController',
            deferPublication: true,
          });
        } catch (error) {
          if (!fallbackRefreshToken || !isInvalidGrantError(error)) {
            throw error;
          }
          logger.info(
            '[refreshController] Session refresh token was rejected; retrying the distinct browser token',
          );
          successfulRefreshToken = fallbackRefreshToken;
          refreshResult = await refreshOpenIDUser({
            req,
            res,
            user: refreshUser,
            refreshToken: fallbackRefreshToken,
            browserRefreshToken: parsedCookies.refreshToken,
            strategyName: 'refreshController (browser fallback)',
            deferPublication: true,
          });
        }
        const { tokenset, claims, openidIssuer, user, error, migration } = refreshResult;

        if (error || !user) {
          logger.warn(
            `[refreshController] Redirecting to /login: error=${error ?? 'null'}, user=${user ? 'exists' : 'null'}`,
          );
          clearSessionHintCookie(res);
          return res.status(401).redirect('/login');
        }

        if (user._id.toString() !== refreshUser._id.toString()) {
          logger.warn(
            '[refreshController] Refreshed identity resolved a different user; refusing token issuance',
            {
              refreshUserId: refreshUser._id.toString(),
              resolvedUserId: user._id.toString(),
            },
          );
          clearSessionHintCookie(res);
          return res.status(401).redirect('/login');
        }

        // Handle migration: update user with openidId if found by email without openidId
        // Also handle case where user has mismatched openidId (e.g., after database switch)
        if (migration || user.openidId !== claims.sub) {
          const reason = migration ? 'migration' : 'openidId mismatch';
          await updateUser(user._id.toString(), {
            provider: 'openid',
            openidId: claims.sub,
            ...(openidIssuer ? { openidIssuer } : {}),
          });
          logger.info(`[refreshController] Updated user ${user._id} openidId (${reason})`);
        }

        if (
          successfulRefreshToken !== refreshToken &&
          req.session?.openidTokens?.refreshToken === refreshToken
        ) {
          delete req.session.openidTokens;
        }

        const token = await sendOpenIDAuthResponse({
          tokenset,
          user,
          existingRefreshToken: successfulRefreshToken,
          openidSubject: claims?.sub,
          openidIssuer,
          predecessorIdentity: {
            userId: refreshUser._id.toString(),
            tenantId: refreshUser.tenantId,
            openidIssuer: refreshUser.openidIssuer,
          },
          rejectedRefreshTokens: successfulRefreshToken === refreshToken ? [] : [refreshToken],
          req,
          res,
        });
        return await withOpenIDResponseDelivery(
          {
            res,
            openidTokens: req.session?.openidTokens,
            context: 'refreshController',
          },
          (sendAuthorized) =>
            sendAuthorized(() =>
              res.status(200).send({ token, user: sanitizeUserForAuthResponse(user) }),
            ),
        );
      });
    } catch (error) {
      if (isOpenIDRefreshOwnershipError(error) || isOpenIDSessionMissingError(error)) {
        clearOpenIDAuthTokens(
          req,
          res,
          req.session?.openidTokens?.appUserId,
          req.session?.openidTokens?.tenantId,
        );
      }
      if (isOpenIDSessionMissingError(error)) {
        logger.warn('[refreshController] OpenID session missing; sign-in required');
        return res.status(401).send({ code: 'OPENID_SESSION_MISSING' });
      }
      logger.error('[refreshController] OpenID token refresh error', error);

      /**
       * Detect and recover from stale refresh-token cookie after SSE-triggered rotation.
       * If the initial refresh with the cookie fails with invalid_grant, check if a
       * recovery bridge exists. Bridges are stored when an OBO refresh rotates the token
       * but cannot set the browser cookie (headers already sent during SSE streaming).
       */
      const bridgeSourceToken = parsedCookies.refreshToken;
      if (isInvalidGrantError(error) && bridgeSourceToken) {
        // Bridge lookup uses the signed user-id cookie because /refresh is unauthenticated.
        const userId = getValidOpenIDReuseCredential(
          parsedCookies,
          process.env.JWT_REFRESH_SECRET,
          bridgeSourceToken,
        )?.userId;
        if (userId) {
          try {
            const bridgeUser = await runAsSystem(async () =>
              getUserById(userId, AUTH_REFRESH_USER_PROJECTION),
            );
            if (!bridgeUser) {
              clearSessionHintCookie(res);
              return res.status(403).send('Invalid OpenID refresh token');
            }

            const bridgeResponse = await runInUserTenant(bridgeUser, async () => {
              const bridgedRefreshToken = await getRefreshTokenBridge({
                oldRefreshToken: bridgeSourceToken,
                userId,
                tenantId: bridgeUser.tenantId,
                openidIssuer: bridgeUser.openidIssuer,
              });

              if (bridgedRefreshToken) {
                logger.info(
                  '[refreshController] Recovered via refresh-token bridge after invalid_grant',
                  {
                    userId,
                  },
                );

                try {
                  const { appAuthToken } = await recoverOpenIDRefreshBridge({
                    req,
                    res,
                    refreshToken: bridgeSourceToken,
                    bridgedRefreshToken,
                    bridgeUser,
                  });

                  return await withOpenIDResponseDelivery(
                    {
                      res,
                      openidTokens: req.session?.openidTokens,
                      context: 'refreshController',
                    },
                    (sendAuthorized) =>
                      sendAuthorized(() =>
                        res.status(200).send({
                          token: appAuthToken,
                          user: sanitizeUserForAuthResponse(bridgeUser),
                        }),
                      ),
                  );
                } catch (retryError) {
                  logger.error('[refreshController] Bridge recovery retry failed', retryError);
                  // Fall through to generic error response
                }
              }
            });
            if (bridgeResponse !== undefined) {
              return bridgeResponse;
            }
          } catch (bridgeError) {
            logger.warn('[refreshController] Refresh-token bridge lookup failed', {
              error: bridgeError instanceof Error ? bridgeError.message : bridgeError,
            });
          }
        }
      }

      clearSessionHintCookie(res);
      return res.status(403).send('Invalid OpenID refresh token');
    }
  }

  /** For non-OpenID users, delegate refresh to the typed local handler. */
  return refreshLocalSession(req, res, parsedCookies.refreshToken);
};

const graphTokenController = async (req, res) => {
  try {
    // Validate user is authenticated via Entra ID
    if (!req.user.openidId || req.user.provider !== 'openid') {
      return res.status(403).json({
        message: 'Microsoft Graph access requires Entra ID authentication',
      });
    }

    // Check if OpenID token reuse is active (required for on-behalf-of flow)
    if (!isEnabled(process.env.OPENID_REUSE_TOKENS)) {
      return res.status(403).json({
        message: 'SharePoint integration requires OpenID token reuse to be enabled',
      });
    }

    const scopes = req.query.scopes;
    if (!scopes) {
      return res.status(400).json({
        message: 'Graph API scopes are required as query parameter',
      });
    }

    const accessToken = req.user.federatedTokens?.access_token;
    if (!accessToken) {
      return res.status(401).json({
        message: 'No federated access token available for token exchange',
      });
    }

    const sessionTokens = req.session?.openidTokens;
    const usesSessionToken = Boolean(
      sessionTokens?.accessToken && sessionTokens.accessToken === accessToken,
    );
    const requestBearer = req.headers?.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (req.session && !usesSessionToken && requestBearer !== accessToken) {
      throw createOpenIDRefreshOwnershipError('OpenID session tokens are no longer available');
    }
    const exchangeAndSend = async (sendAuthorized) => {
      const tokenResponse = await getGraphApiToken(req.user, accessToken, scopes);
      return sendAuthorized(() => res.json(tokenResponse));
    };
    if (usesSessionToken) {
      return await withOpenIDResponseDelivery(
        {
          res,
          openidTokens: sessionTokens,
          context: 'graphTokenController',
        },
        exchangeAndSend,
      );
    }
    return await exchangeAndSend((send) => send());
  } catch (error) {
    if (isOpenIDRefreshOwnershipError(error)) {
      const userId = req.user?.id ?? req.user?._id?.toString?.();
      clearOpenIDAuthTokens(req, res, userId, req.session?.openidTokens?.tenantId);
      return res.status(401).json({ message: 'OpenID session is no longer authorized' });
    }
    logger.error('[graphTokenController] Failed to obtain Graph API token:', error);
    return res.status(500).json({
      message: 'Failed to obtain Microsoft Graph token',
    });
  }
};

module.exports = {
  refreshController,
  registrationController,
  resetPasswordController,
  resetPasswordRequestController,
  graphTokenController,
};
