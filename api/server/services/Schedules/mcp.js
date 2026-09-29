const { createScheduleMCPPreflight } = require('@librechat/api');
const { CacheKeys } = require('librechat-data-provider');
const { getMCPManager, getMCPServersRegistry, getFlowStateManager } = require('~/config');
const { getAppConfig } = require('~/server/services/Config/app');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const { exchangeOboToken } = require('~/server/services/OboTokenService');
const { createOboTrustChecker } = require('~/server/services/OboPolicyService');
const { getLogStores } = require('~/cache');
const methods = require('~/models');

/**
 * Builds the schedule MCP preflight with an optional host-owned renewable
 * credential resolver. The default application has no durable upstream
 * credential source and therefore remains fail-closed for unattended OBO.
 *
 * @param {object} [options]
 * @param {import('@librechat/api').HostUpstreamTokenProviderResolver} [options.resolveUpstreamTokenProvider]
 */
function createMCPPreflight(options = {}) {
  return createScheduleMCPPreflight({
    getRoleByName: methods.getRoleByName,
    resolveAgentGraphAccess: methods.resolveAgentGraphAccess,
    getAgentGraphNodes: methods.getAgentGraphNodes,
    getModelsConfig: (user) => getModelsConfig({ user }),
    getUser: (id) => methods.findUser({ _id: id }),
    getAppConfig,
    ensureConfigServers: (config, limit) =>
      getMCPServersRegistry().ensureConfigServers(config, limit),
    getServerConfigs: (userId, config, role) =>
      getMCPServersRegistry().getAllServerConfigs(userId, config, role),
    findPluginAuthsByKeys: methods.findPluginAuthsByKeys,
    resolveUpstreamTokenProvider: options.resolveUpstreamTokenProvider,
    connect: (connectionOptions) =>
      getMCPManager().getConnection({
        ...connectionOptions,
        flowManager: getFlowStateManager(getLogStores(CacheKeys.FLOWS)),
        tokenMethods: {
          findToken: methods.findToken,
          updateToken: methods.updateToken,
          createToken: methods.createToken,
          deleteTokens: methods.deleteTokens,
        },
        graphTokenResolver: getGraphApiToken,
        oboTokenResolver: exchangeOboToken,
        oboTrustChecker: createOboTrustChecker(),
      }),
  });
}

module.exports = createMCPPreflight();
module.exports.createMCPPreflight = createMCPPreflight;
