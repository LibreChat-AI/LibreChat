const rateLimit = require('express-rate-limit');
const { removePorts, limiterCache } = require('@librechat/api');
const { getBackchannelLogoutConfig } = require('~/server/services/ProviderSession');

function buildLimiter(config) {
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    keyGenerator: removePorts,
    store: limiterCache('backchannel_logout_limiter'),
  });
}

let limiterPromise = null;

/** Built once the resolved config is available, since `express-rate-limit` needs a fixed
 *  `windowMs` at construction; a failed load is never cached, so the next request retries. */
function getLimiter() {
  if (!limiterPromise) {
    limiterPromise = getBackchannelLogoutConfig()
      .then(buildLimiter)
      .catch((error) => {
        limiterPromise = null;
        throw error;
      });
  }
  return limiterPromise;
}

async function backchannelLogoutLimiter(req, res, next) {
  const limiter = await getLimiter();
  limiter(req, res, next);
}

module.exports = backchannelLogoutLimiter;
