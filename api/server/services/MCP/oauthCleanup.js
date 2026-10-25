const { CacheKeys } = require('librechat-data-provider');
const { MCPOAuthHandler, MCPTokenStorage, cleanupMCPServerOAuth } = require('@librechat/api');
const { getFlowStateManager, getMCPServersRegistry } = require('~/config');
const { getLogStores } = require('~/cache');
const db = require('~/models');

/** Revocation must still reach a server the owner's profile hides. */
const INCLUDE_HIDDEN = { includeHidden: true };

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
      getServerConfig: (serverName, ownerId) =>
        registry.getServerConfig(serverName, ownerId, undefined, undefined, INCLUDE_HIDDEN),
      isRegisteredOAuthServer: async (serverName, ownerId) =>
        (await registry.getOAuthServers(ownerId, INCLUDE_HIDDEN)).has(serverName),
    },
  });
};

module.exports = { maybeUninstallOAuthMCP };
