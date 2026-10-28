const mongoose = require('mongoose');
const { CacheKeys } = require('librechat-data-provider');
const { AppService } = require('@librechat/data-schemas');
const {
  isEnabled,
  expandCustomEndpoint,
  createAppConfigService,
  clearMcpConfigCache,
  createCodeEnvironmentRegistry,
  createConfigCacheInvalidation,
  createRedisConfigInvalidationPubSub,
  mergeAccessibleCodeEnvironments,
  ioredisClient,
  cacheConfig,
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

const loadBaseConfig = async (mode) => {
  /** @type {TCustomConfig} */
  const config = (await loadCustomConfig(true, { mode })) ?? {};
  /** @type {Record<string, FunctionTool>} */
  const systemTools = loadAndFormatTools({
    adminFilter: config.filteredTools,
    adminIncluded: config.includedTools,
    directory: paths.structuredTools,
  });
  return AppService({ config, paths, systemTools, expandCustomEndpoint });
};

const appConfigService = createAppConfigService({
  loadBaseConfig,
  setCachedTools,
  getCache: getLogStores,
  cacheKeys: CacheKeys,
  getApplicableConfigs: db.getApplicableConfigs,
  getUserPrincipals: db.getUserPrincipals,
  overrideEnvAllowlist: process.env.CONFIG_OVERRIDE_ENV_ALLOWLIST,
  rederiveEndpoints: isEnabled(process.env.CONFIG_REDERIVE_ENDPOINTS),
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
});
const {
  getAppConfig,
  resolveConfigLayers,
  clearAppConfigCache,
  clearOverrideCache,
  reloadBaseConfig,
  overrideCacheTtl,
  rederiveEndpoints,
} = appConfigService;

// Config owns the reader; models never import this module to obtain it.
db.initializeMessageBudget(getAppConfig);

/**
 * Admin config writes clear the per-principal override caches, the MCP config-source servers
 * and the YAML base config. Base-only sections such as `filters` and `messageFilter` exist only
 * in librechat.yaml, and an admin write is how a running server picks up an edit to them: the
 * next read reloads the YAML (keeping the last good config if it fails) and republishes the
 * tools derived from it. With Redis, the clear is broadcast so every instance reloads its YAML
 * and drops its in-process merged config.
 */
const configCacheInvalidation = createConfigCacheInvalidation({
  clears: [
    { label: 'clearAppConfigCache', clear: () => clearAppConfigCache() },
    { label: 'clearOverrideCache', clear: clearOverrideCache },
    { label: 'clearMcpConfigCache', clear: () => clearMcpConfigCache() },
  ],
  load: reloadBaseConfig,
  pubsub: createRedisConfigInvalidationPubSub({
    useRedis: cacheConfig.USE_REDIS,
    client: ioredisClient,
    namespace: cacheConfig.REDIS_KEY_PREFIX,
  }),
});

/**
 * Invalidate the config caches an admin config mutation affects, on every instance.
 * @param {string} [tenantId] - Optional tenant ID to scope override cache clearing.
 */
function invalidateConfigCaches(tenantId) {
  return configCacheInvalidation.invalidate(tenantId);
}

/**
 * The same clear for the admin reload route, then librechat.yaml loaded again here and, when it
 * loaded, the broadcast; resolves with what each step reached.
 * @param {string} [tenantId] - Optional tenant ID to scope override cache clearing.
 * @returns {Promise<import('@librechat/api').ConfigReloadReport>}
 */
function reloadConfigCaches(tenantId) {
  return configCacheInvalidation.reload(tenantId);
}

module.exports = {
  getAppConfig,
  resolveConfigLayers,
  overrideCacheTtl,
  rederiveEndpoints,
  invalidateConfigCaches,
  reloadConfigCaches,
  getCodeEnvironmentRegistry,
  invalidateCodeEnvironmentConfigCache,
};
