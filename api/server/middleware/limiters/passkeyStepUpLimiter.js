const rateLimit = require('express-rate-limit');
const { limiterCache } = require('@librechat/api');

const { PASSKEY_STEPUP_WINDOW = 15, PASSKEY_STEPUP_MAX = 20 } = process.env;
const windowMs = PASSKEY_STEPUP_WINDOW * 60 * 1000;
const max = PASSKEY_STEPUP_MAX;
const windowInMinutes = windowMs / 60000;
const message = `Too many passkey confirmation attempts, please try again after ${windowInMinutes} minutes.`;

/**
 * Caps password-confirmed passkey management attempts, covering both enrollment
 * and deletion. One shared budget is deliberate: each of those routes verifies
 * the account password, so separate budgets would hand an attacker holding a
 * stolen token twice the guesses.
 *
 * Keyed by user id, not by IP: the routes sit behind `requireJwtAuth`, and an
 * IP key would let unrelated traffic from a shared NAT exhaust a legitimate
 * user's budget. It also gets its own cache namespace so the unauthenticated
 * sign-in limiter and these routes never share a bucket.
 *
 * No violation is logged. A password typo here is not a login attempt, and
 * feeding it into the login ban system would let a signed-in user lock
 * themselves out of the application.
 */
const passkeyStepUpLimiter = rateLimit({
  windowMs,
  max,
  handler: (req, res) => res.status(429).json({ message }),
  keyGenerator: function (req) {
    return req.user?.id;
  },
  store: limiterCache('passkey_stepup_limiter'),
});

module.exports = passkeyStepUpLimiter;
