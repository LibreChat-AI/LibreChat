const rateLimit = require('express-rate-limit');
const { ViolationTypes } = require('librechat-data-provider');
const {
  limiterCache,
  removePorts,
  getRateLimitReset,
  createAgentEventLimiter,
} = require('@librechat/api');
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
 * Agent event admission, built after startup checks apply `rateLimits` from librechat.yaml.
 */
const agentEventUserLimiter = createAgentEventLimiter({
  max: process.env.AGENT_EVENT_USER_MAX,
  window: process.env.AGENT_EVENT_USER_WINDOW,
  store: limiterCache('agent_event_user_limiter'),
});

module.exports = {
  agentEventUserLimiter,
  messageIpLimiter,
  messageUserLimiter,
};
