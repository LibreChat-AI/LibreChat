const { createScheduleMCPRuntimeHost } = require('@librechat/api');
const { getMCPServersRegistry } = require('~/config');
const { getAppConfig } = require('~/server/services/Config/app');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { resolveAgentFireAccess } = require('./access');
const methods = require('~/models');

module.exports = createScheduleMCPRuntimeHost({
  methods,
  getScheduleMCPCompletionState: methods.getScheduleMCPCompletionState,
  findUser: (id) => methods.findUser({ _id: id }),
  getRoleByName: methods.getRoleByName,
  canViewAgent: async (agentId, user) => (await resolveAgentFireAccess(agentId, user)) === 'ok',
  enrollment: {
    canUseRoot: async (agentId, user) => (await resolveAgentFireAccess(agentId, user)) === 'ok',
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
