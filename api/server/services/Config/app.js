const mongoose = require('mongoose');
const { CacheKeys } = require('librechat-data-provider');
const { AppService, logger } = require('@librechat/data-schemas');
const {
  createDeploymentConfigService,
  createConfigGenerationTracker,
  createRedisConfigGenerationStore,
  clearMcpConfigCache,
  createCodeEnvironmentRegistry,
  mergeAccessibleCodeEnvironments,
  cacheConfig,
  ioredisClient,
  standardCache,
} = require('@librechat/api');
const { setCachedTools } = require('./getCachedTools');
const { loadAndFormatTools } = require('~/server/services/start/tools');
const loadCustomConfig = require('./loadCustomConfig');
const getLogStores = require('~/cache/getLogStores');
const paths = require('~/config/paths');
const db = require('~/models');

let codeEnvironmentRegistry;

function getCodeEnvironmentRegistry() {
  if (codeEnvironmentRegistry == null) {
    codeEnvironmentRegistry = createCodeEnvironmentRegistry(mongoose, {
      configurationCache: cacheConfig.USE_REDIS
        ? standardCache('CODE_ENVIRONMENT_CONFIG')
        : undefined,
    });
  }
  return codeEnvironmentRegistry;
}

async function invalidateCodeEnvironmentConfigCache(tenantId) {
  await getCodeEnvironmentRegistry().invalidateAccessibleConfigurations(tenantId);
}

const buildBaseConfig = async (config) => {
  /** @type {Record<string, FunctionTool>} */
  const systemTools = loadAndFormatTools({
    adminFilter: config.filteredTools,
    adminIncluded: config.includedTools,
    directory: paths.structuredTools,
  });
  return AppService({ config, paths, systemTools });
};

const configGeneration = createConfigGenerationTracker(
  cacheConfig.USE_REDIS && ioredisClient ? createRedisConfigGenerationStore(ioredisClient) : null,
  { bootstrapTimeoutMs: cacheConfig.REDIS_CONNECT_TIMEOUT },
);

const {
  getAppConfig,
  getConfigRefreshStatus,
  getConfigGenerationForConfig,
  clearAppConfigCache,
  clearOverrideCache,
  reloadCustomConfig,
} = createDeploymentConfigService({
  loadCustomConfig,
  buildBaseConfig,
  generation: configGeneration,
  configService: {
    setCachedTools,
    getCache: getLogStores,
    cacheKeys: CacheKeys,
    getApplicableConfigs: db.getApplicableConfigs,
    getUserPrincipals: db.getUserPrincipals,
    augmentConfig: ({ appConfig, baseConfig, principals, options }) => {
      if (!options.userId) return appConfig;
      return mergeAccessibleCodeEnvironments({
        appConfig,
        deploymentConfig: baseConfig,
        actor: {
          userId: options.userId,
          role: options.role ?? null,
          idOnTheSource: options.idOnTheSource ?? null,
          principals,
        },
        registry: getCodeEnvironmentRegistry(),
      });
    },
  },
});

/**
 * Invalidate all config-related caches after an admin config mutation.
 * Clears the base config, per-principal overrides and MCP config-source cache.
 * Global static tools remain startup-owned; clearing them here would leave them
 * absent until a restart while live reload intentionally pins tool filters.
 * @param {string} [tenantId] - Optional tenant ID to scope override cache clearing.
 */
async function invalidateConfigCaches(tenantId) {
  const results = await Promise.allSettled([
    clearAppConfigCache(),
    clearOverrideCache(tenantId),
    clearMcpConfigCache(),
  ]);
  const labels = ['clearAppConfigCache', 'clearOverrideCache', 'clearMcpConfigCache'];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      logger.error(`[invalidateConfigCaches] ${labels[i]} failed:`, results[i].reason);
    }
  }
}

module.exports = {
  getAppConfig,
  getConfigRefreshStatus,
  getConfigGenerationForConfig,
  clearAppConfigCache,
  clearOverrideCache,
  invalidateConfigCaches,
  reloadCustomConfig,
  getCodeEnvironmentRegistry,
  invalidateCodeEnvironmentConfigCache,
};
