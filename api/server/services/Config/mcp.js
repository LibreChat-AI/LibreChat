const { createMCPToolCacheService, MCPServersRegistry } = require('@librechat/api');
const {
  getCachedTools,
  updateCachedGlobalTools,
  setCachedToolsWithinGlobalLock,
  getCachedAppServerTools,
  setCachedAppServerTools,
  setCachedToolsIfCurrent,
  getMCPToolsCacheGeneration,
  renewMCPToolsCacheGeneration,
  getNextAppToolsPublicationRevision,
} = require('./getCachedTools');

const {
  syncStaticTools,
  mergeAppTools,
  cacheMCPServerTools,
  updateMCPServerTools,
  getMCPServerTools,
} = createMCPToolCacheService({
  getCachedTools,
  updateCachedGlobalTools,
  setCachedTools: setCachedToolsWithinGlobalLock,
  setCachedToolsIfCurrent,
  getCachedAppServerTools,
  setCachedAppServerTools,
  getServerConfig: (serverName, userId) =>
    MCPServersRegistry.getInstance().getServerConfig(serverName, userId),
  getAllServerConfigs: () => MCPServersRegistry.getInstance().getAllServerConfigs(),
  isAppServerConfig: (serverName, effectiveConfig) =>
    MCPServersRegistry.getInstance().isAppServerConfig(serverName, effectiveConfig),
});

module.exports = {
  syncStaticTools,
  mergeAppTools,
  getMCPServerTools,
  cacheMCPServerTools,
  updateMCPServerTools,
  getMCPToolsCacheGeneration,
  renewMCPToolsCacheGeneration,
  getNextAppToolsPublicationRevision,
};
