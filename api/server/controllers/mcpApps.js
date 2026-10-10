const fs = require('fs');
const path = require('path');
const { logger, getTenantId } = require('@librechat/data-schemas');
const { CacheKeys, resolveMCPAppCspLimits } = require('librechat-data-provider');
const {
  createAuthIdentityContext,
  createMCPAppsController,
  prepareMCPAuthorizationMutation,
} = require('@librechat/api');
const { getMCPManager, getFlowStateManager, getMCPServersRegistry } = require('~/config');
const { getAppConfig, invalidateCachedTools } = require('~/server/services/Config');
const { createOpenIDSessionTokenProvider } = require('~/server/services/OpenIDSessionRefresh');
const {
  clearMCPAuthorizationFenceRetry,
  persistMCPAuthorizationFenceRetry,
} = require('~/server/services/MCPAuthorizationFenceRetry');
const {
  findPluginAuthsByKeys,
  findToken,
  createToken,
  updateToken,
  deleteTokens,
} = require('~/models');
const { getLogStores } = require('~/cache');

module.exports = createMCPAppsController({
  logger,
  sandboxPath: path.resolve(__dirname, '../../../client/public/mcp-sandbox.html'),
  sandboxFrameAncestors: process.env.MCP_SANDBOX_FRAME_ANCESTORS,
  readSandboxFile: fs.readFileSync,
  getManager: getMCPManager,
  getOperationBudget: () => getMCPManager().appOperationBudget,
  getFlowManager: () => getFlowStateManager(getLogStores(CacheKeys.FLOWS)),
  getAppConfig: (req) =>
    getAppConfig({
      role: req.user?.role,
      userId: req.user?.id,
      tenantId: req.user?.tenantId,
      failClosed: true,
    }),
  getSandboxCspLimits: async () => {
    const appConfig = await getAppConfig({ baseOnly: true, failClosed: true });
    return resolveMCPAppCspLimits(appConfig?.mcpAppSandbox);
  },
  ensureConfigServers: (mcpConfig) => getMCPServersRegistry().ensureConfigServers(mcpConfig),
  getAllServerConfigs: (userId, configServers, role) =>
    getMCPServersRegistry().getAllServerConfigs(userId, configServers, role),
  recoverServerConfig: (serverName, config, userId) =>
    getMCPServersRegistry().recoverServerConfig(serverName, config, userId),
  isAppServerConfig: (serverName, config) =>
    getMCPServersRegistry().isAppServerConfig(serverName, config),
  resolveCachedAppServerConfig: (args) =>
    getMCPServersRegistry().resolveCachedAppServerConfig(args),
  findPluginAuthsByKeys,
  tokenMethods: { findToken, createToken, updateToken, deleteTokens },
  createOAuthCredentialsChanging: (req) => {
    const recoveryPolicy = req.config?.mcpSettings?.catalogRecovery;
    return (scope) =>
      prepareMCPAuthorizationMutation(scope, {
        invalidateRecoveryGeneration: invalidateCachedTools,
        persistPublicationRetry: persistMCPAuthorizationFenceRetry,
        clearPublicationRetry: clearMCPAuthorizationFenceRetry,
        clearLocalRecovery: (userId, serverName, generation) =>
          getMCPManager()?.clearCatalogRecoveryState?.(userId, serverName, generation),
        retryDelaysMs: recoveryPolicy?.authorizationFenceRetryMs,
        attemptTimeoutMs: recoveryPolicy?.authorizationFenceTimeoutMs,
      });
  },
  createUpstreamTokenProvider: (req, res, user) =>
    createOpenIDSessionTokenProvider({
      req,
      res,
      user,
      identityContext: createAuthIdentityContext({ user, tenantId: getTenantId() }),
      tokenPreference: 'access_token',
    }),
});
