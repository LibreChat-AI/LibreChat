const { PermissionTypes, Permissions } = require('librechat-data-provider');
const {
  isEnabled,
  onlyForModelNames,
  onlyForRemoteModel,
  createRemoteModelBalanceGate,
  rejectCallerSystemPromptForEnforcedSpec,
  generateCheckAccess,
  preAuthTenantMiddleware,
  createRequireApiKeyAuth,
  createRemoteAgentAuth,
  createAgentManagementAuth,
  createCheckAgentTriggerAccess,
  createCheckRemoteAgentAccess,
} = require('@librechat/api');
const { getEffectivePermissions } = require('~/server/services/PermissionService');
const {
  checkBan,
  messageIpApiLimiter,
  messageUserApiLimiter,
  strictConfigMiddleware,
} = require('~/server/middleware');
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

const managementAuthDeps = {
  findUser: db.findUser,
  isPrincipalActive: db.isAgentTriggerPrincipalActive,
  getAppConfig,
};
const requireAgentManagementAuth = createAgentManagementAuth(managementAuthDeps);
const requireConversationReadAuth = createAgentManagementAuth(managementAuthDeps, {
  requireConversationRead: true,
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
/** Chat completions also accept a model the key's owner can use (remoteApi.models). */
const checkAgentOrModelPermission = createCheckRemoteAgentAccess({
  ...agentAccessDependencies,
  resolveRemoteModel: (req, model) =>
    require('~/server/services/Agents/remoteModels').resolve(req, model),
});
const checkAgentTriggerPermission = createCheckAgentTriggerAccess(agentAccessDependencies);

/** Before resolution, for any `model` that is not a saved agent id: the chat's ban
 *  check, the message limits (answered as API errors), and the owner's config
 *  resolved strictly, so a failed override lookup cannot widen model access. */
const preResolveModelGuards = [
  checkBan,
  ...(isEnabled(process.env.LIMIT_MESSAGE_IP) ? [messageIpApiLimiter] : []),
  ...(isEnabled(process.env.LIMIT_MESSAGE_USER) ? [messageUserApiLimiter] : []),
  strictConfigMiddleware,
].map(onlyForModelNames);

/** After `model` resolved to a model: the owner must have credits (with balances on),
 *  and an enforced spec takes no caller system instructions. */
const remoteModelGuards = [
  createRemoteModelBalanceGate({
    findBalanceByUser: (userId, options) => db.findBalanceByUser(userId, options),
    reserveBalance: (request) => db.reserveBalance(request),
  }),
  rejectCallerSystemPromptForEnforcedSpec,
].map(onlyForRemoteModel);

module.exports = {
  preResolveModelGuards,
  remoteModelGuards,
  checkAgentPermission,
  checkAgentOrModelPermission,
  checkAgentTriggerPermission,
  preAuthTenantMiddleware,
  requireRemoteAgentAuth,
  requireAgentManagementAuth,
  requireConversationReadAuth,
  checkRemoteAgentsFeature,
};
