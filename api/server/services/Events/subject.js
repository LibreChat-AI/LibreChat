const mongoose = require('mongoose');
const {
  createConnections,
  createSubscriptions,
  createSubscriptionGrantStorage,
} = require('@librechat/data-schemas');
const {
  getAgentCheckpointer,
  GenerationJobManager,
  createSubscriptionHost,
  createScheduledPauseCheck,
} = require('@librechat/api');
const { resolveAgentFireAccess } = require('~/server/services/Schedules/access');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getAppConfig } = require('~/server/services/Config/app');
const { getMCPServersRegistry } = require('~/config');
const methods = require('~/models');

const subscriptions = createSubscriptions(mongoose);
const connections = createConnections(mongoose);

// Thin wiring over the TypeScript implementation in packages/api: the grant an event
// subscription's owner makes for it, and the check a run it started is put under.
module.exports = createSubscriptionHost({
  storage: createSubscriptionGrantStorage(mongoose),
  getSubscription: subscriptions.get,
  getConnection: connections.get,
  findUser: (id) => methods.findUser({ _id: id }),
  getRoleByName: methods.getRoleByName,
  access: resolveAgentFireAccess,
  canPauseRuns: createScheduledPauseCheck({
    isSharedStore: () => GenerationJobManager.isRedis,
    getCheckpointer: getAgentCheckpointer,
    getAppConfig,
  }),
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
