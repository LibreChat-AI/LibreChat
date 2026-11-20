const express = require('express');
const { generateCheckAccess, createApiKeyHandlers } = require('@librechat/api');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const {
  getAgentModelSummaries,
  getAgentApiKeyById,
  createAgentApiKey,
  deleteAgentApiKey,
  listAgentApiKeys,
  getRoleByName,
} = require('~/models');
const { findAccessibleResources } = require('~/server/services/PermissionService');
const { getAppConfig } = require('~/server/services/Config/app');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

const handlers = createApiKeyHandlers({
  createAgentApiKey,
  listAgentApiKeys,
  deleteAgentApiKey,
  getAgentApiKeyById,
  getAppConfig,
  findAccessibleResources,
  getAgentModelSummaries,
});

const checkRemoteAgentsUse = generateCheckAccess({
  permissionType: PermissionTypes.REMOTE_AGENTS,
  permissions: [Permissions.USE],
  getRoleByName,
});

router.post('/', requireJwtAuth, checkRemoteAgentsUse, handlers.createApiKey);

router.get('/', requireJwtAuth, checkRemoteAgentsUse, handlers.listApiKeys);

/** Before `/:id`: the agents a key can be granted for. */
router.get('/agents', requireJwtAuth, checkRemoteAgentsUse, handlers.listAgents);

router.get('/:id', requireJwtAuth, checkRemoteAgentsUse, handlers.getApiKey);

router.delete('/:id', requireJwtAuth, checkRemoteAgentsUse, handlers.deleteApiKey);

/** The MCP servers and tools the owner lets a run started with this key use, per agent. */
const grants = () => require('~/server/services/ApiKeys/grants').handlers;
const grantPath = '/:id/agents/:agentId/mcp-consent';

router.get(grantPath, requireJwtAuth, checkRemoteAgentsUse, (req, res) => grants().get(req, res));

router.post(grantPath, requireJwtAuth, checkRemoteAgentsUse, (req, res) =>
  grants().confirm(req, res),
);

router.delete(grantPath, requireJwtAuth, checkRemoteAgentsUse, (req, res) =>
  grants().revoke(req, res),
);

module.exports = router;
