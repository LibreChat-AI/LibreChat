const { limiterCache, createMCPAppRateLimiter } = require('@librechat/api');
const logViolation = require('~/cache/logViolation');

module.exports = createMCPAppRateLimiter('resource', {
  store: limiterCache('mcp_app_resource_limiter'),
  logViolation,
  score: process.env.TOOL_CALL_VIOLATION_SCORE,
});
