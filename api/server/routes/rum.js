const express = require('express');
const {
  limiterCache,
  proxyRumRequest,
  requireRumProxyEnabled,
  getRumProxyBodyLimit,
  requireRumLogsEnabled,
  handleJsonParseError,
  createRumProxyLimiter,
} = require('@librechat/api');
const { requireRumProxyAuth } = require('~/server/middleware');

const router = express.Router();
const rawOtlpBody = express.raw({
  limit: getRumProxyBodyLimit(),
  type: ['application/x-protobuf', 'application/octet-stream'],
});

const rumProxyLimiter = createRumProxyLimiter({ store: limiterCache('rum_proxy_user_limiter') });
const proxyTelemetry = (req, res) => proxyRumRequest(req, res, process.env.RUM_PROXY_AUTHORIZATION);
const telemetryPipeline = [
  requireRumProxyEnabled,
  requireRumProxyAuth,
  rumProxyLimiter,
  express.json({ limit: getRumProxyBodyLimit() }),
  rawOtlpBody,
  handleJsonParseError,
  proxyTelemetry,
];

router.post('/v1/traces', ...telemetryPipeline);
router.post('/v1/logs', requireRumLogsEnabled, ...telemetryPipeline);

module.exports = router;
