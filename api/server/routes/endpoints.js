const express = require('express');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const configMiddleware = require('~/server/middleware/config/app');
const endpointController = require('~/server/controllers/EndpointController');
const tokenConfigController = require('~/server/controllers/TokenConfigController');
const reasoningCapabilitiesController = require('~/server/controllers/ReasoningCapabilitiesController');

const router = express.Router();
/** Auth required for role/tenant-scoped endpoint config resolution. */
router.get('/', requireJwtAuth, configMiddleware, endpointController);
router.get('/token-config', requireJwtAuth, configMiddleware, tokenConfigController);
router.get(
  '/reasoning-capabilities',
  requireJwtAuth,
  configMiddleware,
  reasoningCapabilitiesController,
);

module.exports = router;
