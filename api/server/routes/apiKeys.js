const express = require('express');
const {
  generateCheckAccess,
  createApiKeyHandlers,
  resolveRemoteIntegrations,
  getAppConfigOptionsFromUser,
} = require('@librechat/api');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const {
  getAgentApiKeyById,
  createAgentApiKey,
  deleteAgentApiKey,
  listAgentApiKeys,
  getRoleByName,
} = require('~/models');
const { getAppConfig } = require('~/server/services/Config/app');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

const handlers = createApiKeyHandlers({
  createAgentApiKey,
  listAgentApiKeys,
  deleteAgentApiKey,
  getAgentApiKeyById,
  usesGrants: async (req) =>
    resolveRemoteIntegrations(await getAppConfig(getAppConfigOptionsFromUser(req.user))).mode ===
    'delegated',
});

const checkRemoteAgentsUse = generateCheckAccess({
  permissionType: PermissionTypes.REMOTE_AGENTS,
  permissions: [Permissions.USE],
  getRoleByName,
});

router.post('/', requireJwtAuth, checkRemoteAgentsUse, handlers.createApiKey);

router.get('/', requireJwtAuth, checkRemoteAgentsUse, handlers.listApiKeys);

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
