const { CacheKeys } = require('librechat-data-provider');
const {
  cacheConfig,
  evalKeyvRedisScript,
  ioredisClient,
  keyvRedisClient,
  waitForKeyvRedisClient,
  mcpConfig,
  ToolCacheKeys,
  createMCPCatalogStore,
} = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');

const store = createMCPCatalogStore({
  cacheConfig,
  ioredisClient,
  keyvRedisClient: keyvRedisClient ? { eval: evalKeyvRedisScript } : null,
  waitForRedis: waitForKeyvRedisClient,
  userConnectionIdleTimeout: mcpConfig.USER_CONNECTION_IDLE_TIMEOUT,
  getCache: () => getLogStores(CacheKeys.TOOL_CACHE),
});

module.exports = { ToolCacheKeys, ...store };
