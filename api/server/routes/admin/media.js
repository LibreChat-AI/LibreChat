const { createAdminMediaRouter } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  requireCapability,
  getHeldCapabilities,
} = require('~/server/middleware/roles/capabilities');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { recordAuditEntry } = require('~/models');

module.exports = createAdminMediaRouter({
  services: (req) => req.app.locals.mediaRuntime?.recovery,
  getWorkerHealth: (req) => req.app.locals.mediaRuntime?.worker.health,
  requireJwtAuth,
  requireCapability,
  getHeldCapabilities,
  recordAuditEntry,
  log: logger.error.bind(logger),
});
