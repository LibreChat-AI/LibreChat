const rateLimit = require('express-rate-limit');
const { ViolationTypes } = require('librechat-data-provider');
const { limiterCache, removePorts, getRateLimitReset } = require('@librechat/api');
const denyRequest = require('~/server/middleware/denyRequest');
const { logViolation } = require('~/cache');

const {
  MESSAGE_IP_MAX = 40,
  MESSAGE_IP_WINDOW = 1,
  MESSAGE_USER_MAX = 40,
  MESSAGE_USER_WINDOW = 1,
  MESSAGE_VIOLATION_SCORE: score,
} = process.env;

const ipWindowMs = MESSAGE_IP_WINDOW * 60 * 1000;
const ipMax = MESSAGE_IP_MAX;
const ipWindowInMinutes = ipWindowMs / 60000;

const userWindowMs = MESSAGE_USER_WINDOW * 60 * 1000;
const userMax = MESSAGE_USER_MAX;
const userWindowInMinutes = userWindowMs / 60000;

/**
 * Creates either an IP/User message request rate limiter for excessive requests
 * that properly logs and denies the violation.
 *
 * @param {boolean} [ip=true] - Whether to create an IP limiter or a user limiter.
 * @returns {function} A rate limiter function.
 *
 */
const createHandler = (ip = true) => {
  return async (req, res) => {
    const type = ViolationTypes.MESSAGE_LIMIT;
    const errorMessage = {
      type,
      max: ip ? ipMax : userMax,
      limiter: ip ? 'ip' : 'user',
      windowInMinutes: ip ? ipWindowInMinutes : userWindowInMinutes,
      ...getRateLimitReset(req.rateLimit, ip ? ipWindowMs : userWindowMs),
    };

    await logViolation(req, res, type, errorMessage, score);
    return await denyRequest(req, res, errorMessage);
  };
};

/**
 * Message request rate limiters
 */
const ipLimiterOptions = {
  windowMs: ipWindowMs,
  max: ipMax,
  handler: createHandler(),
  keyGenerator: removePorts,
  store: limiterCache('message_ip_limiter'),
};

const userLimiterOptions = {
  windowMs: userWindowMs,
  max: userMax,
  handler: createHandler(false),
  keyGenerator: function (req) {
    return req.user?.id;
  },
  store: limiterCache('message_user_limiter'),
};

/**
 * Message request rate limiter by IP
 */
const messageIpLimiter = rateLimit(ipLimiterOptions);

/**
 * Message request rate limiter by userId
 */
const messageUserLimiter = rateLimit(userLimiterOptions);

/**
 * Event admission has its own API-principal bucket. The durable worker later
 * consumes the normal message-user bucket when it executes the delivery, so
 * sharing that limiter here would charge every event twice.
 */
let configuredAgentEventUserLimiter;
const agentEventUserLimiter = (req, res, next) => {
  if (configuredAgentEventUserLimiter == null) {
    const max = Number(process.env.AGENT_EVENT_USER_MAX ?? 40);
    const windowInMinutes = Number(process.env.AGENT_EVENT_USER_WINDOW ?? 1);
    configuredAgentEventUserLimiter = rateLimit({
      windowMs: windowInMinutes * 60 * 1000,
      max,
      handler: (limitedReq, limitedRes) => {
        const { retryAfterSeconds } = getRateLimitReset(
          limitedReq.rateLimit,
          windowInMinutes * 60 * 1000,
        );
        limitedRes.set('Retry-After', String(retryAfterSeconds));
        return limitedRes
          .status(429)
          .type('application/json')
          .json({
            error: {
              code: 'agent_event_rate_limited',
              message: 'Agent event admission rate limit exceeded.',
              type: 'rate_limit_error',
            },
          });
      },
      keyGenerator: (limitedReq) => String(limitedReq.apiKeyId ?? limitedReq.user?.id),
      store: limiterCache('agent_event_user_limiter'),
    });
  }
  return configuredAgentEventUserLimiter(req, res, next);
};

module.exports = {
  agentEventUserLimiter,
  messageIpLimiter,
  messageUserLimiter,
};
