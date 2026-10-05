const rateLimit = require('express-rate-limit');
const { createMessageLimiters, limiterCache } = require('@librechat/api');
const denyRequest = require('~/server/middleware/denyRequest');
const { logViolation } = require('~/cache');

module.exports = createMessageLimiters({
  factory: rateLimit,
  createStore: limiterCache,
  environment: process.env,
  logViolation,
  denyRequest,
});
