const express = require('express');
const { createAdminDeadLetterHandlers, isAuditFailClosed } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { agentTriggerDeadLetters } = require('~/server/services/Agents/triggers');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadEvents = requireCapability(SystemCapabilities.READ_EVENTS);
const requireManageEvents = requireCapability(SystemCapabilities.MANAGE_EVENTS);

const handlers = createAdminDeadLetterHandlers({
  letters: agentTriggerDeadLetters,
  recordAuditEntry: db.recordAuditEntry,
  auditFailClosed: isAuditFailClosed(),
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/dead', requireReadEvents, handlers.list);
router.post('/dead/:id/requeue', requireManageEvents, handlers.requeue);
router.delete('/dead/:id', requireManageEvents, handlers.dismiss);

module.exports = router;
