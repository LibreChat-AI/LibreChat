const { limiterCache, createMCPAppRateLimiter } = require('@librechat/api');
const logViolation = require('~/cache/logViolation');

module.exports = createMCPAppRateLimiter('toolCall', {
  store: limiterCache('mcp_app_tool_call_limiter'),
  logViolation,
  score: process.env.TOOL_CALL_VIOLATION_SCORE,
});
