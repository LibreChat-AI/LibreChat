const express = require('express');
const { createAdminCodeEnvironmentHandlers, isAuditFailClosed } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { getAppConfig } = require('~/server/services/Config');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireCodeEnvironmentManage = requireCapability(
  SystemCapabilities.MANAGE_CODE_ENVIRONMENTS,
  { platformOnly: true },
);
const handlers = createAdminCodeEnvironmentHandlers({
  getAppConfig,
  recordAuditEntry: db.recordAuditEntry,
  auditFailClosed: isAuditFailClosed(),
});

router.use(requireJwtAuth, requireAdminAccess, requireCodeEnvironmentManage);
router.post('/:environmentId/pairings', handlers.createPairing);
router.post('/:environmentId/revoke', handlers.revokeWorker);

module.exports = router;
