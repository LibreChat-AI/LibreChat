'use strict';

const config = require('../config');

const windowMs = 60_000;
let requestCount = 0;
let windowStart = Date.now();

function adminRateLimit(req, res, next) {
  const now = Date.now();
  if (now - windowStart >= windowMs) {
    windowStart = now;
    requestCount = 0;
  }

  requestCount += 1;
  if (requestCount > config.adminRateLimitRpm) {
    res.status(429).json({ error: 'Admin API rate limit exceeded' });
    return;
  }

  next();
}

module.exports = { adminRateLimit };
