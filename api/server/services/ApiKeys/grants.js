const mongoose = require('mongoose');
const { createAgentKeyMCPConsentStorage } = require('@librechat/data-schemas');
const { createAgentKeyMCPGrantHost } = require('@librechat/api');
const { getEffectivePermissions } = require('~/server/services/PermissionService');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getAppConfig } = require('~/server/services/Config/app');
const { getMCPServersRegistry } = require('~/config');
const methods = require('~/models');

// Thin wiring over the TypeScript implementation in packages/api: the grants an API key's
// owner makes for it, and the check a run started with that key is put under.
module.exports = createAgentKeyMCPGrantHost({
  storage: createAgentKeyMCPConsentStorage(mongoose),
  findUser: (id) => methods.findUser({ _id: id }),
  getRoleByName: methods.getRoleByName,
  getAgent: methods.getAgent,
  getEffectivePermissions,
  getKey: methods.getAgentApiKeyById,
  enrollment: {
    getAppConfig,
    resolveGraphAccess: (user) =>
      methods.resolveAgentGraphAccess({
        userId: user.id,
        role: user.role,
        idOnTheSource: user.idOnTheSource,
      }),
    getNodes: methods.getAgentGraphNodes,
    getModelsConfig: (user) => getModelsConfig({ user }),
    ensureConfigServers: (config) => getMCPServersRegistry().ensureConfigServers(config),
    getServers: (user, config) =>
      getMCPServersRegistry().getAllServerConfigs(user.id, config, user.role),
  },
});
