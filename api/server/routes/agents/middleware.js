const { PermissionTypes, Permissions } = require('librechat-data-provider');
const {
  generateCheckAccess,
  preAuthTenantMiddleware,
  createRequireApiKeyAuth,
  createRemoteAgentAuth,
  createAgentManagementAuth,
  createManagementAdminAuth,
  createCheckAgentTriggerAccess,
  createCheckRemoteAgentAccess,
} = require('@librechat/api');
const { requireJwtAuth, requireTermsAcceptance } = require('~/server/middleware');
const { getEffectivePermissions } = require('~/server/services/PermissionService');
const { getAppConfig } = require('~/server/services/Config');
const db = require('~/models');

const apiKeyMiddleware = createRequireApiKeyAuth({
  authorizeBinding: (...args) =>
    require('~/server/services/ChannelAuthority').authorizeChannelResponseKeyRequest(...args),
  validateAgentApiKey: db.validateAgentApiKey,
  validateBoundAgentApiKey: db.validateBoundAgentApiKey,
  findUser: db.findUser,
  isPrincipalActive: db.isAgentTriggerPrincipalActive,
});

const requireRemoteAgentAuth = createRemoteAgentAuth({
  apiKeyMiddleware,
  findUser: db.findUser,
  getRolesByNames: db.findRolesByNames,
  updateUser: db.updateUser,
  isPrincipalActive: db.isAgentTriggerPrincipalActive,
  getAppConfig,
  recordAuditEntry: db.recordAuditEntry,
});

const requireAgentManagementAuth = createAgentManagementAuth({
  findUser: db.findUser,
  isPrincipalActive: db.isAgentTriggerPrincipalActive,
  getAppConfig,
});

/**
 * Authenticates an admin route as a management client holding `scope` in its binding's
 * `adminScopes`, or as a browser session through `requireJwtAuth` for every other request.
 * @param {import('librechat-data-provider').ManagementAdminScopes} scope
 */
const requireManagementOrJwtAuth = (scope) =>
  createManagementAdminAuth({
    findUser: db.findUser,
    isPrincipalActive: db.isAgentTriggerPrincipalActive,
    getAppConfig,
    scope,
    fallback: requireJwtAuth,
    afterManagementAuth: requireTermsAcceptance,
  });

const checkRemoteAgentsFeature = generateCheckAccess({
  permissionType: PermissionTypes.REMOTE_AGENTS,
  permissions: [Permissions.USE],
  getRoleByName: db.getRoleByName,
});

const agentAccessDependencies = {
  getAgent: db.getAgent,
  getEffectivePermissions,
};

const checkAgentPermission = createCheckRemoteAgentAccess(agentAccessDependencies);
const checkAgentTriggerPermission = createCheckAgentTriggerAccess(agentAccessDependencies);

module.exports = {
  checkAgentPermission,
  checkAgentTriggerPermission,
  preAuthTenantMiddleware,
  requireRemoteAgentAuth,
  requireAgentManagementAuth,
  requireManagementOrJwtAuth,
  checkRemoteAgentsFeature,
};
