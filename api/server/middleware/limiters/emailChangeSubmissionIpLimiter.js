const rateLimit = require('express-rate-limit');
const { ViolationTypes } = require('librechat-data-provider');
const { limiterCache, removePorts } = require('@librechat/api');
const { logViolation } = require('~/cache');

/**
 * Confirmation is unauthenticated and `emailChangeSubmissionLimiter` keys on the
 * caller-supplied `userId`, so rotating that id yields a fresh bucket per request.
 * This layer bounds the whole source address, keeping the per-user limiter's
 * isolation without letting one client issue unbounded token lookups.
 */
const {
  EMAIL_CHANGE_CONFIRM_IP_WINDOW = 2,
  EMAIL_CHANGE_CONFIRM_IP_MAX = 20,
  EMAIL_CHANGE_SUBMISSION_IP_VIOLATION_SCORE: score,
} = process.env;
const windowMs = EMAIL_CHANGE_CONFIRM_IP_WINDOW * 60 * 1000;
const max = EMAIL_CHANGE_CONFIRM_IP_MAX;
const windowInMinutes = windowMs / 60000;
const message = `Too many attempts, please try again after ${windowInMinutes} minute(s)`;

const handler = async (req, res) => {
  const type = ViolationTypes.VERIFY_EMAIL_LIMIT;
  const errorMessage = {
    type,
    max,
    windowInMinutes,
    limiter: 'submission_ip',
  };

  await logViolation(req, res, type, errorMessage, score);
  return res.status(429).json({ message });
};

const limiterOptions = {
  windowMs,
  max,
  handler,
  keyGenerator: removePorts,
  store: limiterCache('email_change_submission_ip_limiter'),
};

const emailChangeSubmissionIpLimiter = rateLimit(limiterOptions);

module.exports = emailChangeSubmissionIpLimiter;
