const rateLimit = require('express-rate-limit');
const { ErrorTypes, ViolationTypes } = require('librechat-data-provider');
const { limiterCache, removePorts } = require('@librechat/api');
const { isOAuthNavigation, redirectOAuthFailure } = require('~/server/middleware/oauthNavigation');
const { logViolation } = require('~/cache');

const { LOGIN_WINDOW = 5, LOGIN_MAX = 7, LOGIN_VIOLATION_SCORE: score } = process.env;
const windowMs = LOGIN_WINDOW * 60 * 1000;
const max = LOGIN_MAX;
const windowInMinutes = windowMs / 60000;
const message = `Too many login attempts, please try again after ${windowInMinutes} minutes.`;

const handler = async (req, res) => {
  const type = ViolationTypes.LOGINS;
  const errorMessage = {
    type,
    max,
    windowInMinutes,
  };

  await logViolation(req, res, type, errorMessage, score);

  /** A browser navigation would render the JSON body as the page. */
  if (isOAuthNavigation(req)) {
    return redirectOAuthFailure(res, ErrorTypes.AUTH_RATE_LIMITED);
  }

  return res.status(429).json({ message });
};

const limiterOptions = {
  windowMs,
  max,
  handler,
  keyGenerator: removePorts,
  store: limiterCache('login_limiter'),
};

const loginLimiter = rateLimit(limiterOptions);

module.exports = loginLimiter;
