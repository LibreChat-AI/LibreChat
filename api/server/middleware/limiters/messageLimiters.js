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
 *
 * Built on load: both server entries require the routes after startup checks
 * have applied `rateLimits.agentEvents` from librechat.yaml to the environment.
 */
const eventWindowMs = Number(process.env.AGENT_EVENT_USER_WINDOW ?? 1) * 60 * 1000;
const agentEventUserLimiter = rateLimit({
  windowMs: eventWindowMs,
  max: Number(process.env.AGENT_EVENT_USER_MAX ?? 40),
  handler: (req, res) => {
    const { retryAfterSeconds } = getRateLimitReset(req.rateLimit, eventWindowMs);
    res.set('Retry-After', String(retryAfterSeconds));
    return res
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
  keyGenerator: (req) => String(req.apiKeyId ?? req.user?.id),
  store: limiterCache('agent_event_user_limiter'),
});

module.exports = {
  agentEventUserLimiter,
  messageIpLimiter,
  messageUserLimiter,
};
