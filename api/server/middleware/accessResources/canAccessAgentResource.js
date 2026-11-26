const { toUpdatableAgent, createAgentAccessMiddleware } = require('@librechat/api');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { checkPermission } = require('~/server/services/PermissionService');
const { getAgent } = require('~/models');

const deps = {
  getAgent: (agentId) => getAgent({ id: agentId }),
  getAgentWithVersions: (agentId) => getAgent({ id: agentId }, {}).then(toUpdatableAgent),
  hasCapability,
  checkPermission,
};

/**
 * Agent route middleware. It authorizes `req.user` on the agent named by a route
 * parameter through `authorizeAgent` in `@librechat/api`.
 *
 * @param {Object} options - Configuration options
 * @param {number} options.requiredPermission - The permission bits required (1=view, 2=edit, 4=delete, 8=share)
 * @param {string} [options.resourceIdParam='id'] - The name of the route parameter containing the agent custom ID
 * @param {boolean} [options.includeVersions=false] - Load the version history with the agent
 * @returns {Function} Express middleware function
 *
 * @example
 * router.patch('/agents/:agent_id',
 *   canAccessAgentResource({ requiredPermission: 2, resourceIdParam: 'agent_id' }),
 *   updateAgent
 * );
 */
const canAccessAgentResource = (options) => createAgentAccessMiddleware(options, deps);

module.exports = {
  canAccessAgentResource,
};
