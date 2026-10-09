const express = require('express');
const { generateCheckAccess } = require('@librechat/api');
const { PermissionTypes, Permissions, PermissionBits } = require('librechat-data-provider');
const { configMiddleware, canAccessAgentResource } = require('~/server/middleware');
const v1 = require('~/server/controllers/agents/v1');
const { getRoleByName } = require('~/models');
const actions = require('./actions');
const tools = require('./tools');

const router = express.Router();
const avatar = express.Router();

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

/**
 * Agent actions route.
 * @route GET|POST /agents/actions
 */
router.use('/actions', configMiddleware, actions);

/**
 * Get a list of available tools for agents.
 * @route GET /agents/tools
 */
router.use('/tools', configMiddleware, tools);

/**
 * Get all agent categories with counts
 * @route GET /agents/categories
 */
router.get('/categories', v1.getAgentCategories);
/**
 * Creates an agent.
 * @route POST /agents
 * @param {AgentCreateParams} req.body - The agent creation parameters.
 * @returns {Agent} 201 - Success response - application/json
 */
router.post('/', checkAgentCreate, configMiddleware, v1.createAgent);

/**
 * Retrieves basic agent information (VIEW permission required).
 * Returns safe, non-sensitive agent data for viewing purposes.
 * @route GET /agents/:id
 * @param {string} req.params.id - Agent identifier.
 * @returns {Agent} 200 - Basic agent info - application/json
 */
router.get(
  '/:id',
  checkAgentAccess,
  canAccessAgentResource({
    requiredPermission: PermissionBits.VIEW,
    resourceIdParam: 'id',
  }),
  v1.getAgent,
);

/**
 * Retrieves full agent details including sensitive configuration (EDIT permission required).
 * Returns complete agent data for editing/configuration purposes.
 * @route GET /agents/:id/expanded
 * @param {string} req.params.id - Agent identifier.
 * @returns {Agent} 200 - Full agent details - application/json
 */
router.get(
  '/:id/expanded',
  checkAgentAccess,
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'id',
  }),
  (req, res) => v1.getAgent(req, res, true), // Expanded version
);

/**
 * Retrieves an agent's version history (EDIT permission required).
 * Loaded lazily so the editor doesn't transfer large histories up front.
 * @route GET /agents/:id/versions
 * @param {string} req.params.id - Agent identifier.
 * @returns {Agent[]} 200 - Agent version history - application/json
 */
router.get(
  '/:id/versions',
  checkAgentAccess,
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'id',
  }),
  v1.getAgentVersions,
);
/**
 * Updates an agent.
 * @route PATCH /agents/:id
 * @param {string} req.params.id - Agent identifier.
 * @param {AgentUpdateParams} req.body - The agent update parameters.
 * @returns {Agent} 200 - Success response - application/json
 */
router.patch(
  '/:id',
  checkAgentCreate,
  configMiddleware,
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'id',
  }),
  configMiddleware,
  v1.updateAgent,
);

/**
 * Duplicates an agent.
 * @route POST /agents/:id/duplicate
 * @param {string} req.params.id - Agent identifier.
 * @returns {Agent} 201 - Success response - application/json
 */
router.post(
  '/:id/duplicate',
  checkAgentCreate,
  configMiddleware,
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'id',
  }),
  configMiddleware,
  v1.duplicateAgent,
);

/**
 * Deletes an agent.
 * @route DELETE /agents/:id
 * @param {string} req.params.id - Agent identifier.
 * @returns {Agent} 200 - success response - application/json
 */
router.delete(
  '/:id',
  checkAgentCreate,
  canAccessAgentResource({
    requiredPermission: PermissionBits.DELETE,
    resourceIdParam: 'id',
  }),
  v1.deleteAgent,
);

/**
 * Reverts an agent to a previous version.
 * @route POST /agents/:id/revert
 * @param {string} req.params.id - Agent identifier.
 * @param {number} req.body.version_index - Index of the version to revert to.
 * @returns {Agent} 200 - success response - application/json
 */
router.post(
  '/:id/revert',
  checkAgentCreate,
  configMiddleware,
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'id',
  }),
  configMiddleware,
  v1.revertAgentVersion,
);

/**
 * Returns a list of agents.
 * @route GET /agents
 * @param {AgentListParams} req.query - The agent list parameters for pagination and sorting.
 * @returns {AgentListResponse} 200 - success response - application/json
 */
router.get('/', checkAgentAccess, v1.getListAgents);

/**
 * Uploads and updates an avatar for a specific agent.
 * @route POST /agents/:agent_id/avatar
 * @param {string} req.params.agent_id - The ID of the agent.
 * @param {Express.Multer.File} req.file - The avatar image file.
 * @param {string} [req.body.metadata] - Optional metadata for the agent's avatar.
 * @returns {Object} 200 - success response - application/json
 */
avatar.post(
  '/:agent_id/avatar/',
  checkAgentAccess,
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'agent_id',
  }),
  v1.uploadAgentAvatar,
);

module.exports = { v1: router, avatar };
