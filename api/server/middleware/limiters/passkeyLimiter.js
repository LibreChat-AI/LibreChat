const rateLimit = require('express-rate-limit');
const { ViolationTypes } = require('librechat-data-provider');
const { limiterCache, removePorts } = require('@librechat/api');
const { logViolation } = require('~/cache');

const { PASSKEY_WINDOW = 5, PASSKEY_MAX = 20, LOGIN_VIOLATION_SCORE: score } = process.env;
const windowMs = PASSKEY_WINDOW * 60 * 1000;
const max = PASSKEY_MAX;
const windowInMinutes = windowMs / 60000;
const message = `Too many passkey attempts, please try again after ${windowInMinutes} minutes.`;

const handler = async (req, res) => {
  const type = ViolationTypes.LOGINS;
  await logViolation(req, res, type, { type, max, windowInMinutes }, score);
  return res.status(429).json({ message });
};

/**
 * Guards the unauthenticated passkey endpoints. A single sign-in spends two
 * requests (options, then verify), so this is deliberately more permissive than
 * `loginLimiter` and tracked separately from password attempts.
 */
const passkeyLimiter = rateLimit({
  windowMs,
  max,
  handler,
  keyGenerator: removePorts,
  store: limiterCache('passkey_limiter'),
});

module.exports = passkeyLimiter;
