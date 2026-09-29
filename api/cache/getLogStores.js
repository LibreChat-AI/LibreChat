const { Keyv } = require('keyv');
const { Time, CacheKeys, ViolationTypes } = require('librechat-data-provider');
const {
  logFile,
  keyvMongo,
  cacheConfig,
  sessionCache,
  standardCache,
  violationCache,
  userPrincipalsCache,
  registerShutdownTask,
} = require('@librechat/api');

/** No-op store for cache namespaces that are deliberately disabled. */
const disabledCache = {
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
  clear: async () => undefined,
};

const namespaces = {
  [ViolationTypes.GENERAL]: new Keyv({ store: logFile, namespace: 'violations' }),
  [ViolationTypes.LOGINS]: violationCache(ViolationTypes.LOGINS),
  [ViolationTypes.CONCURRENT]: violationCache(ViolationTypes.CONCURRENT),
  [ViolationTypes.NON_BROWSER]: violationCache(ViolationTypes.NON_BROWSER),
  [ViolationTypes.MESSAGE_LIMIT]: violationCache(ViolationTypes.MESSAGE_LIMIT),
  [ViolationTypes.REGISTRATIONS]: violationCache(ViolationTypes.REGISTRATIONS),
  [ViolationTypes.TOKEN_BALANCE]: violationCache(ViolationTypes.TOKEN_BALANCE),
  [ViolationTypes.TTS_LIMIT]: violationCache(ViolationTypes.TTS_LIMIT),
  [ViolationTypes.STT_LIMIT]: violationCache(ViolationTypes.STT_LIMIT),
  [ViolationTypes.CONVO_ACCESS]: violationCache(ViolationTypes.CONVO_ACCESS),
  [ViolationTypes.SHARE_LIMIT]: violationCache(ViolationTypes.SHARE_LIMIT),
  [ViolationTypes.TOOL_CALL_LIMIT]: violationCache(ViolationTypes.TOOL_CALL_LIMIT),
  [ViolationTypes.FILE_UPLOAD_LIMIT]: violationCache(ViolationTypes.FILE_UPLOAD_LIMIT),
  [ViolationTypes.VERIFY_EMAIL_LIMIT]: violationCache(ViolationTypes.VERIFY_EMAIL_LIMIT),
  [ViolationTypes.RESET_PASSWORD_LIMIT]: violationCache(ViolationTypes.RESET_PASSWORD_LIMIT),
  [ViolationTypes.ILLEGAL_MODEL_REQUEST]: violationCache(ViolationTypes.ILLEGAL_MODEL_REQUEST),
  [ViolationTypes.BAN]: new Keyv({
    store: keyvMongo,
    namespace: CacheKeys.BANS,
    ttl: cacheConfig.BAN_DURATION,
  }),

  [CacheKeys.OPENID_SESSION]: sessionCache(CacheKeys.OPENID_SESSION),
  [CacheKeys.SAML_SESSION]: sessionCache(CacheKeys.SAML_SESSION),

  [CacheKeys.ROLES]: standardCache(CacheKeys.ROLES),
  [CacheKeys.USER_PRINCIPALS]: userPrincipalsCache() ?? disabledCache,
  /** Authorization IDs stay uncached because a failed shared invalidation cannot fail closed. */
  [CacheKeys.PROMPT_GROUPS_ACCESS]: disabledCache,
  [CacheKeys.APP_CONFIG]: standardCache(CacheKeys.APP_CONFIG),
  [CacheKeys.CONFIG_STORE]: standardCache(CacheKeys.CONFIG_STORE),
  [CacheKeys.TOOL_CACHE]: standardCache(CacheKeys.TOOL_CACHE),
  [CacheKeys.PENDING_REQ]: standardCache(CacheKeys.PENDING_REQ),
  [CacheKeys.ENCODED_DOMAINS]: new Keyv({ store: keyvMongo, namespace: CacheKeys.ENCODED_DOMAINS }),
  [CacheKeys.ABORT_KEYS]: standardCache(CacheKeys.ABORT_KEYS, Time.TEN_MINUTES),
  [CacheKeys.TOKEN_CONFIG]: standardCache(CacheKeys.TOKEN_CONFIG, Time.THIRTY_MINUTES),
  [CacheKeys.GEN_TITLE]: standardCache(CacheKeys.GEN_TITLE, Time.TWO_MINUTES),
  [CacheKeys.S3_EXPIRY_INTERVAL]: standardCache(CacheKeys.S3_EXPIRY_INTERVAL, Time.THIRTY_MINUTES),
  [CacheKeys.MODEL_QUERIES]: standardCache(CacheKeys.MODEL_QUERIES),
  [CacheKeys.AUDIO_RUNS]: standardCache(CacheKeys.AUDIO_RUNS, Time.TEN_MINUTES),
  [CacheKeys.MESSAGES]: standardCache(CacheKeys.MESSAGES, Time.ONE_MINUTE),
  [CacheKeys.FLOWS]: standardCache(CacheKeys.FLOWS, Time.ONE_MINUTE * 10),
  [CacheKeys.OPENID_EXCHANGED_TOKENS]: standardCache(
    CacheKeys.OPENID_EXCHANGED_TOKENS,
    Time.TEN_MINUTES,
  ),
  [CacheKeys.AUTH_USER_DOC]: standardCache(CacheKeys.AUTH_USER_DOC),
  [CacheKeys.ADMIN_OAUTH_EXCHANGE]: standardCache(
    CacheKeys.ADMIN_OAUTH_EXCHANGE,
    Time.THIRTY_SECONDS,
  ),
};

/**
 * Gets all cache stores that have TTL configured
 * @returns {Keyv[]}
 */
function getTTLStores() {
  return Object.values(namespaces).filter(
    (store) =>
      store instanceof Keyv &&
      parseInt(store.opts?.ttl ?? '0') > 0 &&
      !store.opts?.store?.constructor?.name?.includes('Redis'), // Only include non-Redis stores
  );
}

/**
 * Clears entries older than the cache's TTL
 * @param {Keyv} cache
 */
async function clearExpiredFromCache(cache) {
  if (!cache?.opts?.store?.entries) {
    return;
  }

  const ttl = cache.opts.ttl;
  if (!ttl) {
    return;
  }

  const expiryTime = Date.now() - ttl;
  let cleared = 0;

  // Get all keys first to avoid modification during iteration
  const keys = Array.from(cache.opts.store.keys());

  for (const key of keys) {
    try {
      const raw = cache.opts.store.get(key);
      if (!raw) {
        continue;
      }

      const data = cache.opts.deserialize(raw);
      // Check if the entry is older than TTL
      if (data?.expires && data.expires <= expiryTime) {
        const deleted = await cache.opts.store.delete(key);
        if (!deleted) {
          cacheConfig.DEBUG_MEMORY_CACHE &&
            console.warn(`[Cache] Error deleting entry: ${key} from ${cache.opts.namespace}`);
          continue;
        }
        cleared++;
      }
    } catch (error) {
      cacheConfig.DEBUG_MEMORY_CACHE &&
        console.log(`[Cache] Error processing entry from ${cache.opts.namespace}:`, error);
      const deleted = await cache.opts.store.delete(key);
      if (!deleted) {
        cacheConfig.DEBUG_MEMORY_CACHE &&
          console.warn(`[Cache] Error deleting entry: ${key} from ${cache.opts.namespace}`);
        continue;
      }
      cleared++;
    }
  }

  if (cleared > 0) {
    cacheConfig.DEBUG_MEMORY_CACHE &&
      console.log(
        `[Cache] Cleared ${cleared} entries older than ${ttl}ms from ${cache.opts.namespace}`,
      );
  }
}

const auditCache = () => {
  const ttlStores = getTTLStores();
  console.log('[Cache] Starting audit');

  ttlStores.forEach((store) => {
    if (!store?.opts?.store?.entries) {
      return;
    }

    console.log(`[Cache] ${store.opts.namespace} entries:`, {
      count: store.opts.store.size,
      ttl: store.opts.ttl,
      keys: Array.from(store.opts.store.keys()),
      entriesWithTimestamps: Array.from(store.opts.store.entries()).map(([key, value]) => ({
        key,
        value,
      })),
    });
  });
};

/**
 * Clears expired entries from all TTL-enabled stores
 */
async function clearAllExpiredFromCache() {
  const ttlStores = getTTLStores();
  await Promise.all(ttlStores.map((store) => clearExpiredFromCache(store)));

  // Force garbage collection if available (Node.js with --expose-gc flag)
  if (global.gc) {
    global.gc();
  }
}

if (!cacheConfig.USE_REDIS && !cacheConfig.CI) {
  /** @type {Set<NodeJS.Timeout>} */
  const cleanupIntervals = new Set();

  // Clear expired entries every 30 seconds
  const cleanup = setInterval(() => {
    clearAllExpiredFromCache();
  }, Time.THIRTY_SECONDS);

  cleanupIntervals.add(cleanup);

  if (cacheConfig.DEBUG_MEMORY_CACHE) {
    const monitor = setInterval(() => {
      const ttlStores = getTTLStores();
      const memory = process.memoryUsage();
      const totalSize = ttlStores.reduce((sum, store) => sum + (store.opts?.store?.size ?? 0), 0);

      console.log('[Cache] Memory usage:', {
        heapUsed: `${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(memory.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        rss: `${(memory.rss / 1024 / 1024).toFixed(2)} MB`,
        external: `${(memory.external / 1024 / 1024).toFixed(2)} MB`,
        totalCacheEntries: totalSize,
      });

      auditCache();
    }, Time.ONE_MINUTE);

    cleanupIntervals.add(monitor);
  }

  // Register cleanup with the centralized graceful-shutdown coordinator
  // (see packages/api/src/app/shutdown.ts) rather than attaching a direct
  // signal handler — multiple competing handlers race the HTTP drain.
  registerShutdownTask('cache cleanup', async () => {
    cacheConfig.DEBUG_MEMORY_CACHE && console.log('[Cache] Cleaning up and shutting down...');
    cleanupIntervals.forEach((interval) => clearInterval(interval));
    cleanupIntervals.clear();
    await clearAllExpiredFromCache();
    cacheConfig.DEBUG_MEMORY_CACHE && console.log('[Cache] Final cleanup completed');
  });
}

/**
 * Returns the keyv cache specified by type.
 * If an invalid type is passed, an error will be thrown.
 *
 * @param {string} key - The key for the namespace to access
 * @returns {Keyv} - If a valid key is passed, returns an object containing the cache store of the specified key.
 * @throws Will throw an error if an invalid key is passed.
 */
const getLogStores = (key) => {
  if (!key || !namespaces[key]) {
    throw new Error(`Invalid store key: ${key}`);
  }
  return namespaces[key];
};

module.exports = getLogStores;
