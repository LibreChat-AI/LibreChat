const express = require('express');
const {
  limiterCache,
  proxyRumRequest,
  isRumProxyEnabled,
  getRumProxyBodyLimit,
  isRumLogsEndpointEnabled,
  createRumProxyLimiter,
} = require('@librechat/api');
const { requireRumProxyAuth } = require('~/server/middleware');

const router = express.Router();
const rawOtlpBody = express.raw({
  limit: getRumProxyBodyLimit(),
  type: ['application/x-protobuf', 'application/octet-stream'],
});

function requireRumProxyEnabled(_req, res, next) {
  if (!isRumProxyEnabled()) {
    return res.status(404).json({ message: 'RUM proxy is not configured' });
  }

  return next();
}

const rumProxyLimiter = createRumProxyLimiter({ store: limiterCache('rum_proxy_user_limiter') });
const proxyTelemetry = (req, res) => proxyRumRequest(req, res, process.env.RUM_PROXY_AUTHORIZATION);
const telemetryPipeline = [
  requireRumProxyEnabled,
  requireRumProxyAuth,
  rumProxyLimiter,
  rawOtlpBody,
  proxyTelemetry,
];

function requireRumLogsEnabled(_req, res, next) {
  if (!isRumLogsEndpointEnabled()) {
    return res.status(404).json({ message: 'RUM logs are not enabled' });
  }

  return next();
}

router.post('/v1/traces', ...telemetryPipeline);
router.post('/v1/logs', requireRumLogsEnabled, ...telemetryPipeline);

module.exports = router;
