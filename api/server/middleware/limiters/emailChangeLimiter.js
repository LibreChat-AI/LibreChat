const rateLimit = require('express-rate-limit');
const { ViolationTypes } = require('librechat-data-provider');
const { limiterCache, removePorts } = require('@librechat/api');
const { logViolation } = require('~/cache');

const {
  EMAIL_CHANGE_USER_WINDOW = 2,
  EMAIL_CHANGE_USER_MAX = 3,
  EMAIL_CHANGE_VIOLATION_SCORE: score,
} = process.env;
const windowMs = EMAIL_CHANGE_USER_WINDOW * 60 * 1000;
const max = EMAIL_CHANGE_USER_MAX;
const windowInMinutes = windowMs / 60000;
const message = `Too many attempts, please try again after ${windowInMinutes} minute(s)`;

const handler = async (req, res) => {
  const type = ViolationTypes.VERIFY_EMAIL_LIMIT;
  const errorMessage = {
    type,
    max,
    windowInMinutes,
  };

  await logViolation(req, res, type, errorMessage, score);
  return res.status(429).json({ message });
};

const limiterOptions = {
  windowMs,
  max,
  handler,
  /** Keyed per account so users sharing an egress address cannot exhaust each
   * other's budget; falls back to the address only for unauthenticated calls. */
  keyGenerator: (req) => req.user?.id ?? removePorts(req),
  store: limiterCache('email_change_limiter'),
};

const emailChangeLimiter = rateLimit(limiterOptions);

module.exports = emailChangeLimiter;
