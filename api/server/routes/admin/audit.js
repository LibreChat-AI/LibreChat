const express = require('express');
const { createAdminAuditLogHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireAuditLogRead = requireCapability(SystemCapabilities.READ_AUDIT_LOG);

const handlers = createAdminAuditLogHandlers({
  listAuditLogPage: db.listAuditLogPage,
  findAuditLogEntry: db.findAuditLogEntry,
  streamAuditLogEntries: db.streamAuditLogEntries,
  verifyAuditChain: db.verifyAuditChain,
});

/**
 * `ACCESS_ADMIN` gates entry to the admin surface; `READ_AUDIT_LOG` then gates
 * this specific feature within that surface. The two capabilities are
 * independent in `CapabilityImplications`, so a role delegated only
 * `READ_AUDIT_LOG` without `ACCESS_ADMIN` would otherwise bypass the admin
 * boundary on this router — every other admin router enforces the same pair.
 */
router.use(requireJwtAuth, requireAdminAccess, requireAuditLogRead);

router.get('/', handlers.listAuditLog);
/** Literal sub-paths MUST precede `/:id` so they aren't matched as `{ id }`. */
router.get('/export.csv', handlers.exportAuditLogCsv);
router.get('/verify', handlers.verifyAuditLog);
router.get('/:id', handlers.getAuditLogEntry);

module.exports = router;
