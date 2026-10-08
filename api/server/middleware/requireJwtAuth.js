const cookies = require('cookie');
const passport = require('passport');
const { logger } = require('@librechat/data-schemas');
const {
  isEnabled,
  isTokenRetired,
  createRequiredTwoFactorGate,
  clearCloudFrontCookies,
  tenantContextMiddleware,
  getAuthFailureReasonCategory,
  buildSafeAuthLogContext,
  maybeRefreshCloudFrontAuthCookiesMiddleware,
  recordRumProxyRequest,
  getValidOpenIdReuseUserId,
  generateTwoFactorSetupToken,
  isTwoFactorEnrollmentRequired,
} = require('@librechat/api');
const { getUserById } = require('~/models');

const hasPassportStrategy = (strategy) =>
  typeof passport._strategy === 'function' && passport._strategy(strategy) != null;

const getAuthenticatedUserId = (user) => user?.id?.toString?.() ?? user?._id?.toString?.();
const refreshCloudFrontCookies =
  maybeRefreshCloudFrontAuthCookiesMiddleware ?? ((_req, _res, next) => next());
const ACCOUNT_DELETION_CODE = 'ACCOUNT_DELETION_IN_PROGRESS';

const getAuthTokenSource = (req) => {
  const authorization = req.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  return typeof value === 'string' && /^Bearer\s+/i.test(value) ? 'bearer' : 'none';
};

const getAuthStrategies = (req) => {
  const cookieHeader = req.headers.cookie;
  const parsedCookies = cookieHeader ? cookies.parse(cookieHeader) : {};
  const tokenProvider = parsedCookies.token_provider;
  const openidReuseEnabled = isEnabled(process.env.OPENID_REUSE_TOKENS);
  const openidJwtAvailable = openidReuseEnabled && hasPassportStrategy('openidJwt');
  const openIdReuseUserId = getValidOpenIdReuseUserId(parsedCookies.openid_user_id);
  const useOpenIdJwt =
    tokenProvider === 'openid' && openidJwtAvailable && openIdReuseUserId != null;

  return {
    tokenProvider,
    tokenSource: getAuthTokenSource(req),
    openidReuseEnabled,
    openidJwtAvailable,
    openIdReuseUserId,
    strategies: useOpenIdJwt ? ['openidJwt', 'jwt'] : ['jwt'],
  };
};

const dropRumTelemetry = (res) => {
  if (!res.headersSent) {
    res.status(204).end();
  }
};

// Keep in sync with packages/api/src/rum/proxy.ts; auth drops are recorded before proxy code runs.
const getRumProxyEndpoint = (req) => {
  if (req.path === '/v1/traces') {
    return 'traces';
  }
  if (req.path === '/v1/logs') {
    return 'logs';
  }
  return 'unknown';
};

const isOpenIdReuseUser = (strategy, user, openIdReuseUserId) =>
  strategy !== 'openidJwt' || getAuthenticatedUserId(user) === openIdReuseUserId;

const requiredTwoFactorGate = createRequiredTwoFactorGate({
  clearCloudFrontCookies,
  getUserById,
  warn: (message) => logger.warn(message),
  generateSetupToken: generateTwoFactorSetupToken,
  enrollmentRequired: isTwoFactorEnrollmentRequired,
  tokenRetired: isTokenRetired,
});

/**
 * Custom Middleware to handle JWT authentication, with support for OpenID token reuse.
 * Switches between JWT and OpenID authentication based on cookies and environment settings.
 *
 * After successful authentication (req.user populated), automatically chains into
 * `tenantContextMiddleware` to propagate request context into AsyncLocalStorage
 * for downstream Mongoose tenant isolation and structured logging.
 */
const requireJwtAuth = (req, res, next) => {
  const {
    tokenProvider,
    tokenSource,
    openidReuseEnabled,
    openidJwtAvailable,
    openIdReuseUserId,
    strategies,
  } = getAuthStrategies(req);
  const authLogState = {
    tokenProvider,
    tokenSource,
    openidReuseEnabled,
    openidJwtAvailable,
    hasOpenIdReuseUserId: openIdReuseUserId != null,
  };
  let primaryFailureReasonCategory;
  let fallbackAttempted = false;

  const logOpenIdFallbackAttempt = ({ fallbackStrategy, reasonCategory, status }) => {
    primaryFailureReasonCategory = reasonCategory;
    fallbackAttempted = true;
    const message = '[requireJwtAuth] OpenID JWT auth failed; trying fallback';
    const context = buildSafeAuthLogContext(req, authLogState, {
      event_name: 'jwt_auth_fallback_attempt',
      primary_strategy: 'openidJwt',
      fallback_strategy: fallbackStrategy,
      fallback_attempted: true,
      reason_category: reasonCategory,
      recovery_classification: 'fallback_attempted',
      strategy_status: status,
    });
    logger.debug({ message, ...context });
  };

  const logAuthenticationFailure = ({ strategy, info, status, err }) => {
    const message = '[requireJwtAuth] Authentication failed after all strategies';
    const reasonCategory = getAuthFailureReasonCategory(err, info);
    const context = buildSafeAuthLogContext(req, authLogState, {
      event_name: 'jwt_auth_rejected',
      primary_strategy: strategies[0],
      fallback_strategy: strategies[1],
      fallback_attempted: fallbackAttempted,
      fallback_succeeded: false,
      attempted_strategies: strategies,
      final_strategy: strategy,
      ...(fallbackAttempted && {
        primary_failure_reason_category: primaryFailureReasonCategory,
      }),
      reason_category: reasonCategory,
      recovery_classification: 'terminal_rejection',
      response_status: status || 401,
    });
    const log =
      fallbackAttempted || reasonCategory === 'malformed_jwt' ? logger.warn : logger.debug;
    log.call(logger, { message, ...context });
  };

  const logFallbackSuccess = (strategy) => {
    if (!fallbackAttempted || strategy !== 'jwt') {
      return;
    }
    const message = '[requireJwtAuth] JWT fallback succeeded after OpenID JWT failure';
    const context = buildSafeAuthLogContext(req, authLogState, {
      event_name: 'jwt_auth_recovered',
      auth_strategy: 'jwt',
      primary_strategy: 'openidJwt',
      fallback_strategy: 'jwt',
      fallback_attempted: true,
      fallback_succeeded: true,
      primary_failure_reason_category: primaryFailureReasonCategory,
      recovery_classification: 'fallback_succeeded',
    });
    logger.debug({ message, ...context });
  };

  const authenticateWithStrategy = (index) => {
    const strategy = strategies[index];
    passport.authenticate(strategy, { session: false }, (err, user, info, status) => {
      if (err) {
        return next(err);
      }
      if (!user) {
        if (index + 1 < strategies.length) {
          logOpenIdFallbackAttempt({
            fallbackStrategy: strategies[index + 1],
            reasonCategory: getAuthFailureReasonCategory(err, info),
            status: status || 401,
          });
          return authenticateWithStrategy(index + 1);
        }
        logAuthenticationFailure({ strategy, info, status, err });
        return res.status(status || 401).json({
          message: info?.message || 'Unauthorized',
          ...(info?.code === ACCOUNT_DELETION_CODE && { code: ACCOUNT_DELETION_CODE }),
        });
      }
      if (strategy === 'openidJwt' && getAuthenticatedUserId(user) !== openIdReuseUserId) {
        if (index + 1 < strategies.length) {
          logOpenIdFallbackAttempt({
            fallbackStrategy: strategies[index + 1],
            reasonCategory: 'principal_mismatch',
            status: 401,
          });
          return authenticateWithStrategy(index + 1);
        }
        logAuthenticationFailure({ strategy, info, status: 401, err });
        return res.status(401).json({ message: 'Unauthorized' });
      }
      req.user = user;
      req.authStrategy = strategy;
      logFallbackSuccess(strategy);
      return requiredTwoFactorGate(req, res, next, () => {
        tenantContextMiddleware(req, res, (tenantErr) => {
          if (tenantErr) {
            return next(tenantErr);
          }
          refreshCloudFrontCookies(req, res, next);
        });
      });
    })(req, res, next);
  };

  authenticateWithStrategy(0);
};

const requireRumProxyAuth = (req, res, next) => {
  const { openIdReuseUserId, strategies } = getAuthStrategies(req);
  const endpoint = getRumProxyEndpoint(req);
  let authErrorSeen = false;

  const dropTelemetry = () => {
    recordRumProxyRequest(endpoint, authErrorSeen ? 'auth_error' : 'auth_drop');
    dropRumTelemetry(res);
  };

  const finishAuthentication = (strategy, user) => {
    req.user = user;
    req.authStrategy = strategy;
    next();
  };

  let nextStrategyIndex = 0;
  const tryNextStrategy = () => {
    const strategy = strategies[nextStrategyIndex];
    nextStrategyIndex += 1;

    if (!strategy) {
      dropTelemetry();
      return;
    }

    passport.authenticate(strategy, { session: false }, (err, user) => {
      authErrorSeen = authErrorSeen || err != null;
      if (err || !user || !isOpenIdReuseUser(strategy, user, openIdReuseUserId)) {
        tryNextStrategy();
        return;
      }

      finishAuthentication(strategy, user);
    })(req, res, next);
  };

  tryNextStrategy();
};

module.exports = requireJwtAuth;
module.exports.requireRumProxyAuth = requireRumProxyAuth;
