const { generateCheckAccess } = require('@librechat/api');
const { PermissionTypes, Permissions, PermissionBits } = require('librechat-data-provider');
const {
  canAccessAgentResource,
} = require('~/server/middleware/accessResources/canAccessAgentResource');
const v1 = require('~/server/controllers/agents/v1');
const { getRoleByName } = require('~/models');

/** The agent builder tools replay these `/api/agents` route chains (see `routes/agents/v1.js`). */
const checkAgentAccess = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE],
  getRoleByName,
});
const checkAgentCreate = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});
const canView = canAccessAgentResource({ requiredPermission: PermissionBits.VIEW });
const canEdit = canAccessAgentResource({ requiredPermission: PermissionBits.EDIT });

/** @type {import('@librechat/api').AgentBuilderRoutes} */
const agentBuilderRoutes = {
  list: [checkAgentAccess, v1.getListAgents],
  get: [checkAgentAccess, canView, v1.getAgent],
  getExpanded: [checkAgentAccess, canEdit, (req, res) => v1.getAgent(req, res, true)],
  create: [checkAgentCreate, v1.createAgent],
  update: [checkAgentCreate, canEdit, v1.updateAgent],
};

module.exports = { agentBuilderRoutes };
