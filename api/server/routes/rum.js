const express = require('express');
const {
  limiterCache,
  proxyRumRequest,
  requireRumProxyEnabled,
  getRumProxyBodyLimit,
  requireRumLogsEnabled,
  handleJsonParseError,
  createRumProxyLimiter,
  loadRumConfig,
} = require('@librechat/api');
const { requireRumProxyAuth } = require('~/server/middleware');
const { getAppConfig } = require('~/server/services/Config/app');

const router = express.Router();
const rawOtlpBody = express.raw({
  limit: getRumProxyBodyLimit(),
  type: ['application/x-protobuf', 'application/octet-stream'],
});

const rumProxyLimiter = createRumProxyLimiter({ store: limiterCache('rum_proxy_user_limiter') });
const proxyTelemetry = (req, res) => proxyRumRequest(req, res, process.env.RUM_PROXY_AUTHORIZATION);
const telemetryPipeline = [
  requireRumProxyAuth,
  rumProxyLimiter,
  loadRumConfig(getAppConfig),
  requireRumProxyEnabled,
];
const proxyPipeline = [
  express.json({ limit: getRumProxyBodyLimit() }),
  rawOtlpBody,
  handleJsonParseError,
  proxyTelemetry,
];

router.post('/v1/traces', ...telemetryPipeline, ...proxyPipeline);
router.post('/v1/logs', ...telemetryPipeline, requireRumLogsEnabled, ...proxyPipeline);

module.exports = router;
