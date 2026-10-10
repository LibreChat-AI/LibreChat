const rateLimit = require('express-rate-limit');
const { ViolationTypes } = require('librechat-data-provider');
const { limiterCache, removePorts, emailChangeSubmissionKey } = require('@librechat/api');
const { logViolation } = require('~/cache');

const {
  EMAIL_CHANGE_CONFIRM_USER_WINDOW = process.env.VERIFY_EMAIL_WINDOW ?? 2,
  EMAIL_CHANGE_CONFIRM_USER_MAX = process.env.VERIFY_EMAIL_MAX ?? 2,
  VERIFY_EMAIL_SUBMISSION_VIOLATION_SCORE: score,
} = process.env;
const windowMs = EMAIL_CHANGE_CONFIRM_USER_WINDOW * 60 * 1000;
const max = EMAIL_CHANGE_CONFIRM_USER_MAX;
const windowInMinutes = windowMs / 60000;
const message = `Too many attempts, please try again after ${windowInMinutes} minute(s)`;

const handler = async (req, res) => {
  const type = ViolationTypes.VERIFY_EMAIL_LIMIT;
  const errorMessage = {
    type,
    max,
    windowInMinutes,
    limiter: 'submission',
  };

  await logViolation(req, res, type, errorMessage, score);
  return res.status(429).json({ message });
};

const limiterOptions = {
  windowMs,
  max,
  handler,
  keyGenerator: (req) => emailChangeSubmissionKey(removePorts(req) ?? 'unknown', req.body?.userId),
  store: limiterCache('email_change_submission_limiter'),
};

const emailChangeSubmissionLimiter = rateLimit(limiterOptions);

module.exports = emailChangeSubmissionLimiter;
