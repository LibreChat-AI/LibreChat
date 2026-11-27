const express = require('express');
const mongoose = require('mongoose');
const { Permissions, PermissionTypes } = require('librechat-data-provider');
const { createConnections, createSubscriptions } = require('@librechat/data-schemas');
const { generateCheckAccess, createSubscriptionHandlers } = require('@librechat/api');
const { resolveAgentFireAccess } = require('~/server/services/Schedules/access');
const { requireJwtAuth } = require('~/server/middleware');
const { getRoleByName } = require('~/models');

const router = express.Router();
router.use(requireJwtAuth);

const checkUse = generateCheckAccess({
  permissionType: PermissionTypes.AGENT_EVENTS,
  permissions: [Permissions.USE],
  getRoleByName,
});
const checkCreate = generateCheckAccess({
  permissionType: PermissionTypes.AGENT_EVENTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

// Thin wiring over the TypeScript implementation in packages/api: an owner's event
// subscriptions, the connections they can pick, and the grant each subscription holds.
const handlers = createSubscriptionHandlers({
  subscriptions: createSubscriptions(mongoose),
  connections: createConnections(mongoose),
  access: resolveAgentFireAccess,
  grants: () => require('~/server/services/Events/subject').service,
});

router.get('/connections', checkUse, handlers.connections);
router.get('/subscriptions', checkUse, handlers.list);
router.post('/subscriptions', checkCreate, handlers.create);
router.patch('/subscriptions/:id', checkCreate, handlers.update);
router.delete('/subscriptions/:id', checkUse, handlers.remove);
router.get('/subscriptions/:id/grant', checkUse, handlers.grant.get);
router.post('/subscriptions/:id/grant', checkCreate, handlers.grant.confirm);
router.delete('/subscriptions/:id/grant', checkUse, handlers.grant.revoke);

module.exports = router;
