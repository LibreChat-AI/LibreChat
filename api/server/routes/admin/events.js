const express = require('express');
const mongoose = require('mongoose');
const {
  isAuditFailClosed,
  createProxyAwareFetch,
  createAdminDeadLetterHandlers,
  createAdminConnectionHandlers,
} = require('@librechat/api');
const { SystemCapabilities, createConnections } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { agentTriggerDeadLetters } = require('~/server/services/Agents/triggers');
const { getAppConfig } = require('~/server/services/Config/app');
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

// Thin wiring over the TypeScript implementation in packages/api: the installs of the
// operator's GitHub App bound to the caller's tenant.
const connections = createAdminConnectionHandlers({
  connections: createConnections(mongoose),
  getAppConfig: () => getAppConfig(),
  env: process.env,
  fetch: createProxyAwareFetch(),
  recordAuditEntry: db.recordAuditEntry,
  auditFailClosed: isAuditFailClosed(),
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/dead', requireReadEvents, handlers.list);
router.post('/dead/:id/requeue', requireManageEvents, handlers.requeue);
router.delete('/dead/:id', requireManageEvents, handlers.dismiss);

router.get('/connections', requireReadEvents, connections.list);
router.post('/connections/install', requireManageEvents, connections.install);
router.post('/connections', requireManageEvents, connections.bind);
router.patch('/connections/:id', requireManageEvents, connections.mark);
router.delete('/connections/:id', requireManageEvents, connections.remove);

module.exports = router;
