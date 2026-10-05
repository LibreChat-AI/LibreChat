const rateLimit = require('express-rate-limit');
const { limiterCache, createUploadLimiters } = require('@librechat/api');
const logViolation = require('~/cache/logViolation');

module.exports = createUploadLimiters({
  factory: rateLimit,
  createStore: limiterCache,
  environment: process.env,
  logViolation,
});
