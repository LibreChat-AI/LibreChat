const { CacheKeys } = require('librechat-data-provider');
const { MCPOAuthHandler, MCPTokenStorage, cleanupMCPServerOAuth } = require('@librechat/api');
const { getFlowStateManager, getMCPServersRegistry } = require('~/config');
const { getLogStores } = require('~/cache');
const db = require('~/models');

const maybeUninstallOAuthMCP = async (userId, pluginKey, appConfig, serverConfigOverride) => {
  const registry = getMCPServersRegistry();
  return cleanupMCPServerOAuth({
    userId,
    pluginKey,
    appConfig,
    serverConfigOverride,
    dependencies: {
      flowManager: getFlowStateManager(getLogStores(CacheKeys.FLOWS)),
      oauthHandler: MCPOAuthHandler,
      tokenStorage: MCPTokenStorage,
      findToken: db.findToken,
      deleteTokens: db.deleteTokens,
      getServerConfig: (serverName, ownerId) => registry.getServerConfig(serverName, ownerId),
      isRegisteredOAuthServer: async (serverName, ownerId) =>
        (await registry.getOAuthServers(ownerId)).has(serverName),
    },
  });
};

module.exports = { maybeUninstallOAuthMCP };
