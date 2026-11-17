const mongoose = require('mongoose');
const { createAgentKeyMCPConsentStorage } = require('@librechat/data-schemas');
const { checkRemoteAgentAccess, createAgentKeyMCPGrantHost } = require('@librechat/api');
const { getEffectivePermissions } = require('~/server/services/PermissionService');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getAppConfig } = require('~/server/services/Config/app');
const { getMCPServersRegistry } = require('~/config');
const methods = require('~/models');

// Thin wiring over the TypeScript implementation in packages/api: the grants an API key's
// owner makes for it, and the check a run started with that key is put under.
const canUseAgent = async (agentId, user) =>
  (
    await checkRemoteAgentAccess({
      userId: user.id,
      role: user.role,
      agentId,
      getAgent: methods.getAgent,
      getEffectivePermissions,
    })
  ).hasAccess;

module.exports = createAgentKeyMCPGrantHost({
  storage: createAgentKeyMCPConsentStorage(mongoose),
  findUser: (id) => methods.findUser({ _id: id }),
  getRoleByName: methods.getRoleByName,
  canUseAgent,
  enrollment: {
    canUseRoot: canUseAgent,
    findUser: (id) => methods.findUser({ _id: id }),
    getAppConfig,
    resolveGraphAccess: (user) =>
      methods.resolveAgentGraphAccess({
        userId: user.id,
        role: user.role,
        idOnTheSource: user.idOnTheSource,
      }),
    getNodes: methods.getAgentGraphNodes,
    getModelsConfig: (user) => getModelsConfig({ user }),
    getServers: (user, config) =>
      getMCPServersRegistry().getAllServerConfigs(user.id, config, user.role),
  },
});
