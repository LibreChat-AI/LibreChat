const express = require('express');
const { getRumProxyBodyLimit, isRumProxyEnabled, proxyRumRequest } = require('@librechat/api');
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

const proxyTelemetry = (req, res) => proxyRumRequest(req, res, process.env.RUM_PROXY_AUTHORIZATION);

router.post('/v1/traces', requireRumProxyEnabled, requireRumProxyAuth, rawOtlpBody, proxyTelemetry);
router.post('/v1/logs', requireRumProxyEnabled, requireRumProxyAuth, rawOtlpBody, proxyTelemetry);

module.exports = router;
