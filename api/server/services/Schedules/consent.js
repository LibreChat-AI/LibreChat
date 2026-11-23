const mongoose = require('mongoose');
const { createScheduleMCPConsentStorage } = require('@librechat/data-schemas');
const {
  getAgentCheckpointer,
  GenerationJobManager,
  createScheduledPauseCheck,
  createScheduleMCPRuntimeHost,
} = require('@librechat/api');
const { getMCPServersRegistry } = require('~/config');
const { getAppConfig } = require('~/server/services/Config/app');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { resolveAgentFireAccess } = require('./access');
const methods = require('~/models');

module.exports = createScheduleMCPRuntimeHost({
  storage: createScheduleMCPConsentStorage(mongoose),
  methods: {
    getScheduleById: methods.getScheduleById,
    getScheduleRunMCP: methods.getScheduleRunMCP,
    getScheduleConversationMCP: methods.getScheduleConversationMCP,
  },
  getScheduleMCPCompletionState: methods.getScheduleMCPCompletionState,
  findUser: (id) => methods.findUser({ _id: id }),
  getRoleByName: methods.getRoleByName,
  canViewAgent: async (agentId, user) => (await resolveAgentFireAccess(agentId, user)) === 'ok',
  canPauseRuns: createScheduledPauseCheck({
    isSharedStore: () => GenerationJobManager.isRedis,
    getCheckpointer: getAgentCheckpointer,
    getAppConfig,
  }),
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
    ensureConfigServers: (config) => getMCPServersRegistry().ensureConfigServers(config),
    getServers: (user, config) =>
      getMCPServersRegistry().getAllServerConfigs(user.id, config, user.role),
  },
});
