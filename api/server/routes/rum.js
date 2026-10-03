const express = require('express');
const {
  limiterCache,
  proxyRumRequest,
  isRumProxyEnabled,
  getRumProxyBodyLimit,
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

router.post('/v1/traces', ...telemetryPipeline);
router.post('/v1/logs', ...telemetryPipeline);

module.exports = router;
