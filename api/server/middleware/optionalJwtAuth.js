const cookies = require('cookie');
const passport = require('passport');
const {
  isEnabled,
  clearCloudFrontCookies,
  continueAfterOptionalAuth,
  tenantContextMiddleware,
  isTwoFactorEnrollmentRequired,
} = require('@librechat/api');

const hasPassportStrategy = (strategy) =>
  typeof passport._strategy === 'function' && passport._strategy(strategy) != null;

// This middleware does not require authentication,
// but if the user is authenticated, it will set the user object
// and establish tenant ALS context.
const optionalJwtAuth = (req, res, next) => {
  const cookieHeader = req.headers.cookie;
  const tokenProvider = cookieHeader ? cookies.parse(cookieHeader).token_provider : null;
  const useOpenIdJwt =
    tokenProvider === 'openid' &&
    isEnabled(process.env.OPENID_REUSE_TOKENS) &&
    hasPassportStrategy('openidJwt');
  const callback = (err, user) => {
    if (err) {
      return next(err);
    }
    if (user) {
      return continueAfterOptionalAuth(
        req,
        res,
        next,
        user,
        useOpenIdJwt ? 'openidJwt' : 'jwt',
        tenantContextMiddleware,
        { clearCloudFrontCookies, enrollmentRequired: isTwoFactorEnrollmentRequired },
      );
    }
    next();
  };
  if (useOpenIdJwt) {
    return passport.authenticate('openidJwt', { session: false }, callback)(req, res, next);
  }
  passport.authenticate('jwt', { session: false }, callback)(req, res, next);
};

module.exports = optionalJwtAuth;
