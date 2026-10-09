const mongoose = require('mongoose');
const { createResolveAgentFireAccess } = require('@librechat/api');
const { checkPermission } = require('~/server/services/PermissionService');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { getRoleByName } = require('~/models');

// Thin wiring over the TypeScript implementation in packages/api: inject the
// api-layer lookups (agent id, role, capability, resource ACL); the authorization
// logic itself lives in @librechat/api so it stays type-checked and in-boundary.
const resolveAgentFireAccess = createResolveAgentFireAccess({
  findAgentObjectId: (agentId) =>
    mongoose.models.Agent.findOne({ id: agentId }).select('_id').lean(),
  getRoleByName,
  hasCapability,
  checkPermission,
});

module.exports = { resolveAgentFireAccess };
