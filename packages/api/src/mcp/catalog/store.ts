import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { CacheKeys, Time } from 'librechat-data-provider';
import type { LCAvailableTools } from '../types';

const GLOBAL_LOCK_TTL_MS = 30_000;
const LOCK_FENCE_SAFETY_MS = 1_000;
const LOCK_RETRY_MS = 25;
const CACHE_ENTRY_VERSION = 1;
const GLOBAL_LOCK_KEY = `${CacheKeys.TOOL_CACHE}:tools:global:write-lock`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const CLAIM_OWNERSHIP_FENCE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then return 0 end
local redisTime = redis.call('TIME')
local now = (tonumber(redisTime[1]) * 1000) + math.floor(tonumber(redisTime[2]) / 1000)
local ttl = tonumber(ARGV[2]) - now - tonumber(ARGV[3])
if ttl <= 0 then return 0 end
redis.call('PSETEX', KEYS[1], ttl, ARGV[1])
return 1
`;

const CREATE_GENERATION_IF_OWNER_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('PSETEX', KEYS[2], ARGV[4], cjson.encode({value=ARGV[2], expires=tonumber(ARGV[3])}))
return 1
`;

const MIGRATE_USER_TOOLS_IF_OWNER_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
local rawGeneration = redis.call('GET', KEYS[3])
if rawGeneration then
  local decoded, generation = pcall(cjson.decode, rawGeneration)
  if not decoded or type(generation) ~= 'table' or generation['value'] ~= ARGV[2] then return 0 end
else
  redis.call('PSETEX', KEYS[3], ARGV[4], cjson.encode({value=ARGV[2], expires=tonumber(ARGV[3])}))
end
local decodedEntry, entry = pcall(cjson.decode, ARGV[5])
if not decodedEntry then return redis.error_reply('Invalid MCP tools migration entry') end
redis.call('PSETEX', KEYS[4], ARGV[7], cjson.encode({value=entry, expires=tonumber(ARGV[6])}))
return 1
`;

const RENEW_GENERATION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local decoded, value = pcall(cjson.decode, raw)
if not decoded or type(value) ~= 'table' or value['value'] ~= ARGV[1] then return 0 end
value['expires'] = tonumber(ARGV[2])
redis.call('PSETEX', KEYS[1], ARGV[3], cjson.encode(value))
return 1
`;

const WRITE_USER_TOOLS_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local decoded, value = pcall(cjson.decode, raw)
if not decoded or type(value) ~= 'table' or value['value'] ~= ARGV[1] then return 0 end
value['expires'] = tonumber(ARGV[2])
redis.call('PSETEX', KEYS[1], ARGV[3], cjson.encode(value))
local decodedEntry, entry = pcall(cjson.decode, ARGV[4])
if not decodedEntry then return redis.error_reply('Invalid MCP tools cache entry') end
redis.call('PSETEX', KEYS[2], ARGV[6], cjson.encode({value=entry, expires=tonumber(ARGV[5])}))
return 1
`;

const WRITE_GLOBAL_IF_OWNER_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local decoded, tools = pcall(cjson.decode, ARGV[2])
if not decoded then return redis.error_reply('Invalid global tools catalog') end
redis.call('PSETEX', KEYS[2], ARGV[4], cjson.encode({value=tools, expires=tonumber(ARGV[3])}))
return 1
`;

const NEXT_APP_TOOLS_REVISION_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('PSETEX', KEYS[1], ARGV[2], ARGV[1])
end
local revision = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return tostring(revision)
`;

const WRITE_APP_TOOLS_IF_CURRENT_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) > tonumber(ARGV[1]) then return 0 end
local rawCurrentEntry = redis.call('GET', KEYS[2])
if rawCurrentEntry then
  local decodedCurrent, currentEntry = pcall(cjson.decode, rawCurrentEntry)
  if decodedCurrent and type(currentEntry) == 'table' and type(currentEntry['value']) == 'table' then
    local storedRevision = currentEntry['value']['publicationRevision']
    local storedRevisionNumber = tonumber(storedRevision)
    if storedRevisionNumber and storedRevisionNumber > tonumber(ARGV[1]) then return 0 end
  end
end
local decodedEntry, entry = pcall(cjson.decode, ARGV[2])
if not decodedEntry then return redis.error_reply('Invalid MCP app tools cache entry') end
redis.call('PSETEX', KEYS[1], ARGV[5], ARGV[1])
redis.call('PSETEX', KEYS[2], ARGV[4], cjson.encode({value=entry, expires=tonumber(ARGV[3])}))
return 1
`;

const DELETE_GLOBAL_IF_OWNER_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[2])
return 1
`;

/**
 * Catalog entries can carry `serverToolName` (redundant server-name prefix
 * stripping): an older replica reading a stripped entry ignores the mapping
 * and calls the stripped key segment upstream. Versioning the MCP catalog
 * slices keeps mixed-version replicas on their own representation during a
 * rolling deploy; stale slices simply expire.
 */
const CATALOG_VERSION = 'v2';

export const ToolCacheKeys = {
  GLOBAL: 'tools:global',
  MCP_APP_SERVER: (serverName: string, configGeneration: string): string =>
    `tools:mcp:app:${CATALOG_VERSION}:${encodeURIComponent(serverName)}:${encodeURIComponent(configGeneration)}`,
  MCP_SERVER: (userId: string, serverName: string, configGeneration?: string): string =>
    configGeneration
      ? `tools:mcp:user:{${encodeURIComponent(userId)}:${encodeURIComponent(serverName)}}:${CATALOG_VERSION}:${encodeURIComponent(configGeneration)}`
      : `tools:mcp:${CATALOG_VERSION}:${userId}:${serverName}`,
  MCP_SERVER_GENERATION: (userId: string, serverName: string): string =>
    `tools:metadata:mcp:user-generation:{${encodeURIComponent(userId)}:${encodeURIComponent(serverName)}}`,
  MCP_SERVER_LEGACY_FENCE: (userId: string, serverName: string): string =>
    `tools:metadata:mcp:user-legacy-fence:{${encodeURIComponent(userId)}:${encodeURIComponent(serverName)}}`,
};

export interface CatalogCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttl?: number): Promise<boolean | void>;
  delete(key: string): Promise<boolean | void>;
}

interface LockRedisClient {
  set(key: string, value: string, mode: 'PX', ttl: number, condition: 'NX'): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

interface KeyvRedisClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface CatalogStoreDeps {
  getCache: () => CatalogCache;
  cacheConfig: {
    FORCED_IN_MEMORY_CACHE_NAMESPACES?: string[];
    REDIS_KEY_PREFIX?: string;
    GLOBAL_PREFIX_SEPARATOR?: string;
  };
  ioredisClient?: LockRedisClient | null;
  keyvRedisClient?: KeyvRedisClient | null;
  waitForRedis?: () => Promise<void>;
  userConnectionIdleTimeout?: number | string;
}

export interface CachedToolsOptions {
  userId?: string;
  serverName?: string;
  configGeneration?: string;
  ttl?: number;
}

export interface GuardedToolsOptions extends CachedToolsOptions {
  userId: string;
  serverName: string;
  configGeneration: string;
  publicationGeneration: string;
}

interface GuardedEntry {
  version: number;
  publicationGeneration: string;
  tools: LCAvailableTools;
}

interface AppToolsEntry {
  version: number;
  publicationRevision: string;
  tools: LCAvailableTools;
}

interface OwnershipFence {
  key: string;
  token: string;
}

export interface MCPCatalogStore {
  getCachedTools: (options?: CachedToolsOptions) => Promise<LCAvailableTools | null>;
  updateCachedGlobalTools: (update: (tools: LCAvailableTools) => LCAvailableTools) => Promise<void>;
  setCachedTools: (tools: LCAvailableTools, options?: CachedToolsOptions) => Promise<boolean>;
  setCachedToolsWithinGlobalLock: (
    tools: LCAvailableTools,
    options?: CachedToolsOptions,
  ) => Promise<boolean>;
  setCachedToolsIfCurrent: (
    tools: LCAvailableTools,
    options: GuardedToolsOptions,
  ) => Promise<boolean>;
  getMCPToolsCacheGeneration: (scope: {
    userId: string;
    serverName: string;
  }) => Promise<string | undefined>;
  renewMCPToolsCacheGeneration: (scope: {
    userId: string;
    serverName: string;
    publicationGeneration: string;
  }) => Promise<boolean>;
  getCachedAppServerTools: (
    serverName: string,
    configGeneration: string,
  ) => Promise<LCAvailableTools | null>;
  getNextAppToolsPublicationRevision: (
    serverName: string,
    configGeneration: string,
  ) => Promise<string>;
  setCachedAppServerTools: (
    serverName: string,
    configGeneration: string,
    tools: LCAvailableTools,
    publicationRevision?: string,
    ttl?: number,
  ) => Promise<boolean>;
  runWithGlobalCacheLock: <T>(operation: () => Promise<T>) => Promise<T>;
  invalidateCachedTools: (options?: {
    userId?: string;
    serverName?: string;
    invalidateGlobal?: boolean;
  }) => Promise<string | undefined>;
}

function isTools(value: unknown): value is LCAvailableTools {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isGuardedEntry(value: unknown): value is GuardedEntry {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<GuardedEntry>;
  return (
    entry.version === CACHE_ENTRY_VERSION &&
    typeof entry.publicationGeneration === 'string' &&
    isTools(entry.tools)
  );
}

function isAppToolsEntry(value: unknown): value is AppToolsEntry {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<AppToolsEntry>;
  return (
    entry.version === CACHE_ENTRY_VERSION &&
    typeof entry.publicationRevision === 'string' &&
    isTools(entry.tools)
  );
}

function parseAppToolsRevision(revision: string): number {
  const parsed = Number(revision);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid MCP app tools publication revision: ${revision}`);
  }
  return parsed;
}

export function createMCPCatalogStore(deps: CatalogStoreDeps): MCPCatalogStore {
  const generationTtl = Math.max(
    Time.ONE_DAY,
    Number.isFinite(Number(deps.userConnectionIdleTimeout))
      ? Number(deps.userConnectionIdleTimeout) * 2
      : 0,
  );
  const userQueues = new Map<string, Promise<void>>();
  const appRevisionCounters = new Map<string, number>();
  const appCommittedRevisions = new Map<string, number>();
  const appRevisionExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const appWriteQueues = new Map<string, Promise<void>>();
  let globalQueue = Promise.resolve();
  let globalLockToken: string | undefined;

  const sharedRedis = (): boolean =>
    deps.ioredisClient != null &&
    deps.keyvRedisClient != null &&
    !deps.cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES?.includes(CacheKeys.TOOL_CACHE);

  const getReadyCache = async (): Promise<CatalogCache> => {
    if (sharedRedis()) {
      await deps.waitForRedis?.();
    }
    return deps.getCache();
  };

  const rawKey = (key: string): string => {
    const namespaced = `${CacheKeys.TOOL_CACHE}:${key}`;
    return deps.cacheConfig.REDIS_KEY_PREFIX
      ? `${deps.cacheConfig.REDIS_KEY_PREFIX}${deps.cacheConfig.GLOBAL_PREFIX_SEPARATOR ?? '::'}${namespaced}`
      : namespaced;
  };
  const rememberAppRevision = (
    revisions: Map<string, number>,
    scope: string,
    revision: number,
  ): void => {
    revisions.set(scope, revision);
    const timerKey = `${revisions === appRevisionCounters ? 'allocated' : 'committed'}:${scope}`;
    const previousTimer = appRevisionExpiryTimers.get(timerKey);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }
    const timer = setTimeout(() => {
      if (revisions.get(scope) === revision) {
        revisions.delete(scope);
      }
      appRevisionExpiryTimers.delete(timerKey);
    }, Time.TWELVE_HOURS);
    timer.unref?.();
    appRevisionExpiryTimers.set(timerKey, timer);
  };
  function withAppWriteQueue<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const previous = appWriteQueues.get(scope) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    appWriteQueues.set(scope, tail);
    void tail.then(() => appWriteQueues.get(scope) === tail && appWriteQueues.delete(scope));
    return result;
  }
  const redisHashTag = (key: string): string => {
    const openingBrace = key.indexOf('{');
    const closingBrace = openingBrace >= 0 ? key.indexOf('}', openingBrace + 1) : -1;
    return closingBrace > openingBrace + 1 ? key.slice(openingBrace + 1, closingBrace) : key;
  };
  const globalCacheRawKey = rawKey(ToolCacheKeys.GLOBAL);
  /** Hashes to the same Redis Cluster slot as the unchanged legacy global catalog key. */
  const globalFenceKey = `tools:global:write-fence:{${redisHashTag(globalCacheRawKey)}}`;

  async function withRedisLock<T>(
    lockKey: string,
    ttl: number,
    operation: (token?: string, leaseExpiresAt?: number) => Promise<T>,
  ): Promise<T> {
    if (!sharedRedis()) {
      return operation();
    }
    await deps.waitForRedis?.();
    const redis = deps.ioredisClient!;
    const token = randomUUID();
    const deadline = Date.now() + ttl + LOCK_RETRY_MS;
    let leaseExpiresAt = 0;
    while (true) {
      const attemptedLeaseExpiry = Date.now() + ttl;
      if ((await redis.set(lockKey, token, 'PX', ttl, 'NX')) === 'OK') {
        leaseExpiresAt = attemptedLeaseExpiry;
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for tool cache lock ${lockKey}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
    try {
      return await operation(token, leaseExpiresAt);
    } finally {
      try {
        await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token);
      } catch (error) {
        logger.warn(`[MCP Cache] Failed to release tool cache lock ${lockKey}:`, error);
      }
    }
  }

  async function withOwnershipFence<T>(
    fenceKey: string,
    token: string | undefined,
    leaseExpiresAt: number | undefined,
    operation: (fence?: OwnershipFence) => Promise<T>,
  ): Promise<T> {
    if (!sharedRedis() || !token) {
      return operation();
    }
    const fenceTtl = (leaseExpiresAt ?? 0) - Date.now() - LOCK_FENCE_SAFETY_MS;
    if (fenceTtl <= 0) {
      throw new Error('Tool cache lock expired before ownership could be fenced');
    }
    const claimed = await deps.keyvRedisClient!.eval(CLAIM_OWNERSHIP_FENCE_SCRIPT, {
      keys: [fenceKey],
      arguments: [token, String(leaseExpiresAt), String(LOCK_FENCE_SAFETY_MS)],
    });
    if (Number(claimed) !== 1) {
      throw new Error('Tool cache lock expired or was superseded before ownership could be fenced');
    }
    try {
      return await operation({ key: fenceKey, token });
    } finally {
      try {
        await deps.keyvRedisClient!.eval(RELEASE_LOCK_SCRIPT, {
          keys: [fenceKey],
          arguments: [token],
        });
      } catch (error) {
        logger.warn(`[MCP Cache] Failed to release tool cache fence ${fenceKey}:`, error);
      }
    }
  }

  function withUserQueue<T>(
    userId: string,
    serverName: string,
    operation: (fence?: OwnershipFence) => Promise<T>,
    requireOwnershipFence = false,
  ): Promise<T> {
    const scope = JSON.stringify([userId, serverName]);
    const previous = userQueues.get(scope) ?? Promise.resolve();
    const lockKey = `${CacheKeys.TOOL_CACHE}:tools:mcp-write-lock:${encodeURIComponent(userId)}:${encodeURIComponent(serverName)}`;
    const generationRawKey = rawKey(ToolCacheKeys.MCP_SERVER_GENERATION(userId, serverName));
    const fenceKey = `tools:mcp:write-fence:{${redisHashTag(generationRawKey)}}`;
    const locked = () =>
      withRedisLock(lockKey, GLOBAL_LOCK_TTL_MS, (token, leaseExpiresAt) =>
        requireOwnershipFence
          ? withOwnershipFence(fenceKey, token, leaseExpiresAt, operation)
          : operation(),
      );
    const result = previous.then(locked, locked);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    userQueues.set(scope, tail);
    void tail.then(() => userQueues.get(scope) === tail && userQueues.delete(scope));
    return result;
  }

  async function renewIfCurrent(
    cache: CatalogCache,
    key: string,
    publicationGeneration: string,
  ): Promise<boolean> {
    if (sharedRedis()) {
      const renewed = await deps.keyvRedisClient!.eval(RENEW_GENERATION_SCRIPT, {
        keys: [rawKey(key)],
        arguments: [
          publicationGeneration,
          String(Date.now() + generationTtl),
          String(generationTtl),
        ],
      });
      return Number(renewed) === 1;
    }
    if ((await cache.get(key)) !== publicationGeneration) {
      return false;
    }
    if ((await cache.set(key, publicationGeneration, generationTtl)) === false) {
      throw new Error('Tool publication generation cache rejected the lease refresh');
    }
    return true;
  }

  async function setGlobalWithinLock(
    cache: CatalogCache,
    tools: LCAvailableTools,
    ttl: number,
  ): Promise<boolean> {
    if (!sharedRedis()) {
      return (await cache.set(ToolCacheKeys.GLOBAL, tools, ttl)) !== false;
    }
    if (!globalLockToken) {
      throw new Error('Global tool cache write requires lock ownership');
    }
    const written = await deps.keyvRedisClient!.eval(WRITE_GLOBAL_IF_OWNER_SCRIPT, {
      keys: [globalFenceKey, globalCacheRawKey],
      arguments: [globalLockToken, JSON.stringify(tools), String(Date.now() + ttl), String(ttl)],
    });
    if (Number(written) !== 1) {
      throw new Error('Global tool cache lock ownership was lost before write');
    }
    return true;
  }

  async function deleteGlobalWithinLock(cache: CatalogCache): Promise<void> {
    if (!sharedRedis()) {
      await cache.delete(ToolCacheKeys.GLOBAL);
      return;
    }
    if (!globalLockToken) {
      throw new Error('Global tool cache invalidation requires lock ownership');
    }
    const deleted = await deps.keyvRedisClient!.eval(DELETE_GLOBAL_IF_OWNER_SCRIPT, {
      keys: [globalFenceKey, globalCacheRawKey],
      arguments: [globalLockToken],
    });
    if (Number(deleted) !== 1) {
      throw new Error('Global tool cache lock ownership was lost before invalidation');
    }
  }

  function runWithGlobalCacheLock<T>(operation: () => Promise<T>): Promise<T> {
    const locked = () =>
      withRedisLock(GLOBAL_LOCK_KEY, GLOBAL_LOCK_TTL_MS, async (token, leaseExpiresAt) => {
        return withOwnershipFence(globalFenceKey, token, leaseExpiresAt, async (fence) => {
          globalLockToken = fence?.token;
          try {
            return await operation();
          } finally {
            globalLockToken = undefined;
          }
        });
      });
    const result = globalQueue.then(locked, locked);
    globalQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function getCachedTools(
    options: CachedToolsOptions = {},
  ): Promise<LCAvailableTools | null> {
    const cache = await getReadyCache();
    const { userId, serverName, configGeneration } = options;
    if (!userId || !serverName) {
      const global = await cache.get(ToolCacheKeys.GLOBAL);
      return isTools(global) ? global : null;
    }
    const toolsKey = ToolCacheKeys.MCP_SERVER(userId, serverName, configGeneration);
    let cached = await cache.get(toolsKey);
    if (cached == null && configGeneration) {
      cached = await withUserQueue(
        userId,
        serverName,
        async (fence) => {
          const current = await cache.get(toolsKey);
          if (current != null) return current;
          const legacyFenceKey = ToolCacheKeys.MCP_SERVER_LEGACY_FENCE(userId, serverName);
          if ((await cache.get(legacyFenceKey)) != null) {
            return null;
          }
          const legacy = await cache.get(ToolCacheKeys.MCP_SERVER(userId, serverName));
          if (!isTools(legacy)) return null;
          const generationKey = ToolCacheKeys.MCP_SERVER_GENERATION(userId, serverName);
          const generation = await cache.get(generationKey);
          const publicationGeneration =
            typeof generation === 'string' && generation.length > 0 ? generation : randomUUID();
          const migrated: GuardedEntry = {
            version: CACHE_ENTRY_VERSION,
            publicationGeneration,
            tools: legacy,
          };
          if (!sharedRedis()) {
            if (publicationGeneration !== generation) {
              if (
                (await cache.set(generationKey, publicationGeneration, generationTtl)) === false
              ) {
                throw new Error('Tool publication generation cache rejected the migration fence');
              }
            }
            if ((await cache.set(toolsKey, migrated, Time.TWELVE_HOURS)) === false) {
              throw new Error('Tool cache rejected the legacy user catalog migration');
            }
            return migrated;
          }
          if (!fence) {
            throw new Error('Legacy tool migration requires lock ownership');
          }
          const toolsTtl = Time.TWELVE_HOURS;
          const written = await deps.keyvRedisClient!.eval(MIGRATE_USER_TOOLS_IF_OWNER_SCRIPT, {
            keys: [fence.key, rawKey(legacyFenceKey), rawKey(generationKey), rawKey(toolsKey)],
            arguments: [
              fence.token,
              publicationGeneration,
              String(Date.now() + generationTtl),
              String(generationTtl),
              JSON.stringify(migrated),
              String(Date.now() + toolsTtl),
              String(toolsTtl),
            ],
          });
          if (Number(written) < 0) {
            throw new Error('Tool cache lock ownership was lost before legacy migration');
          }
          return Number(written) === 1 ? migrated : await cache.get(toolsKey);
        },
        true,
      );
    }
    if (!isGuardedEntry(cached)) {
      return isTools(cached) ? cached : null;
    }
    const generation = await cache.get(ToolCacheKeys.MCP_SERVER_GENERATION(userId, serverName));
    return generation === cached.publicationGeneration ? cached.tools : null;
  }

  async function updateCachedGlobalTools(
    update: (tools: LCAvailableTools) => LCAvailableTools,
  ): Promise<void> {
    await runWithGlobalCacheLock(async () => {
      const cache = await getReadyCache();
      const current = await cache.get(ToolCacheKeys.GLOBAL);
      const currentTools = isTools(current) ? current : {};
      const next = update(currentTools);
      if (isTools(current) && next === current) {
        return;
      }
      if (!(await setGlobalWithinLock(cache, next, Time.TWELVE_HOURS))) {
        throw new Error('Global tool cache rejected the migration write');
      }
    });
  }

  async function setCachedToolsWithinGlobalLock(
    tools: LCAvailableTools,
    options: CachedToolsOptions = {},
  ): Promise<boolean> {
    const cache = await getReadyCache();
    const ttl = options.ttl ?? Time.TWELVE_HOURS;
    if (options.userId && options.serverName) {
      return (
        (await cache.set(
          ToolCacheKeys.MCP_SERVER(options.userId, options.serverName, options.configGeneration),
          tools,
          ttl,
        )) !== false
      );
    }
    return setGlobalWithinLock(cache, tools, ttl);
  }

  async function setCachedTools(
    tools: LCAvailableTools,
    options: CachedToolsOptions = {},
  ): Promise<boolean> {
    if (options.userId && options.serverName) {
      return withUserQueue(options.userId, options.serverName, () =>
        setCachedToolsWithinGlobalLock(tools, options),
      );
    }
    return runWithGlobalCacheLock(() => setCachedToolsWithinGlobalLock(tools, options));
  }

  async function getMCPToolsCacheGeneration(scope: {
    userId: string;
    serverName: string;
  }): Promise<string> {
    const cache = await getReadyCache();
    const key = ToolCacheKeys.MCP_SERVER_GENERATION(scope.userId, scope.serverName);
    const existing = await cache.get(key);
    if (typeof existing === 'string' && existing.length > 0) return existing;
    return withUserQueue(
      scope.userId,
      scope.serverName,
      async (fence) => {
        const current = await cache.get(key);
        if (typeof current === 'string' && current.length > 0) return current;
        const generation = randomUUID();
        if (!sharedRedis()) {
          if ((await cache.set(key, generation, generationTtl)) === false) {
            throw new Error('Tool publication generation cache rejected the write');
          }
          return generation;
        }
        if (!fence) {
          throw new Error('Tool publication generation creation requires lock ownership');
        }
        const created = await deps.keyvRedisClient!.eval(CREATE_GENERATION_IF_OWNER_SCRIPT, {
          keys: [fence.key, rawKey(key)],
          arguments: [
            fence.token,
            generation,
            String(Date.now() + generationTtl),
            String(generationTtl),
          ],
        });
        if (Number(created) < 0) {
          throw new Error('Tool cache lock ownership was lost before generation creation');
        }
        if (Number(created) === 1) {
          return generation;
        }
        const concurrent = await cache.get(key);
        if (typeof concurrent === 'string' && concurrent.length > 0) {
          return concurrent;
        }
        throw new Error('Tool publication generation changed during creation');
      },
      true,
    );
  }

  async function renewMCPToolsCacheGeneration(scope: {
    userId: string;
    serverName: string;
    publicationGeneration: string;
  }): Promise<boolean> {
    const cache = await getReadyCache();
    return withUserQueue(scope.userId, scope.serverName, () =>
      renewIfCurrent(
        cache,
        ToolCacheKeys.MCP_SERVER_GENERATION(scope.userId, scope.serverName),
        scope.publicationGeneration,
      ),
    );
  }

  async function setCachedToolsIfCurrent(
    tools: LCAvailableTools,
    options: GuardedToolsOptions,
  ): Promise<boolean> {
    const cache = await getReadyCache();
    return withUserQueue(options.userId, options.serverName, async () => {
      const generationKey = ToolCacheKeys.MCP_SERVER_GENERATION(options.userId, options.serverName);
      const guarded: GuardedEntry = {
        version: CACHE_ENTRY_VERSION,
        publicationGeneration: options.publicationGeneration,
        tools,
      };
      if (!sharedRedis()) {
        if (!(await renewIfCurrent(cache, generationKey, options.publicationGeneration))) {
          return false;
        }
        return (
          (await cache.set(
            ToolCacheKeys.MCP_SERVER(options.userId, options.serverName, options.configGeneration),
            guarded,
            options.ttl ?? Time.TWELVE_HOURS,
          )) !== false
        );
      }
      const ttl = options.ttl ?? Time.TWELVE_HOURS;
      const written = await deps.keyvRedisClient!.eval(WRITE_USER_TOOLS_SCRIPT, {
        keys: [
          rawKey(generationKey),
          rawKey(
            ToolCacheKeys.MCP_SERVER(options.userId, options.serverName, options.configGeneration),
          ),
        ],
        arguments: [
          options.publicationGeneration,
          String(Date.now() + generationTtl),
          String(generationTtl),
          JSON.stringify(guarded),
          String(Date.now() + ttl),
          String(ttl),
        ],
      });
      return Number(written) === 1;
    });
  }

  async function getCachedAppServerTools(
    serverName: string,
    configGeneration: string,
  ): Promise<LCAvailableTools | null> {
    const cache = await getReadyCache();
    const value = await cache.get(ToolCacheKeys.MCP_APP_SERVER(serverName, configGeneration));
    if (isAppToolsEntry(value)) {
      return value.tools;
    }
    return isTools(value) ? value : null;
  }

  async function getNextAppToolsPublicationRevision(
    serverName: string,
    configGeneration: string,
  ): Promise<string> {
    const toolsKey = ToolCacheKeys.MCP_APP_SERVER(serverName, configGeneration);
    const scope = JSON.stringify([serverName, configGeneration]);
    const cache = await getReadyCache();
    const cached = await cache.get(toolsKey);
    const cachedRevision = isAppToolsEntry(cached)
      ? parseAppToolsRevision(cached.publicationRevision)
      : 0;
    if (!sharedRedis()) {
      const revision = Math.max(appRevisionCounters.get(scope) ?? 0, cachedRevision) + 1;
      rememberAppRevision(appRevisionCounters, scope, revision);
      return String(revision);
    }
    const toolsRawKey = rawKey(toolsKey);
    const revisionKey = rawKey(`tools:mcp:app-revision:{${redisHashTag(toolsRawKey)}}`);
    const revision = await deps.keyvRedisClient!.eval(NEXT_APP_TOOLS_REVISION_SCRIPT, {
      keys: [revisionKey],
      arguments: [String(cachedRevision), String(Time.TWELVE_HOURS)],
    });
    const parsedRevision = parseAppToolsRevision(String(revision));
    return String(parsedRevision);
  }

  async function setCachedAppServerTools(
    serverName: string,
    configGeneration: string,
    tools: LCAvailableTools,
    publicationRevision = '0',
    ttl = Time.TWELVE_HOURS,
  ): Promise<boolean> {
    const nextRevision = parseAppToolsRevision(publicationRevision);
    const toolsKey = ToolCacheKeys.MCP_APP_SERVER(serverName, configGeneration);
    const entry: AppToolsEntry = {
      version: CACHE_ENTRY_VERSION,
      publicationRevision,
      tools,
    };
    const scope = JSON.stringify([serverName, configGeneration]);
    const cache = await getReadyCache();
    if (!sharedRedis()) {
      return withAppWriteQueue(scope, async () => {
        const cached = await cache.get(toolsKey);
        const cachedRevision = isAppToolsEntry(cached)
          ? parseAppToolsRevision(cached.publicationRevision)
          : 0;
        const currentRevision = Math.max(appCommittedRevisions.get(scope) ?? 0, cachedRevision);
        if (currentRevision > nextRevision) {
          return false;
        }
        if ((await cache.set(toolsKey, entry, ttl)) === false) {
          throw new Error('App tool cache rejected the write');
        }
        rememberAppRevision(appCommittedRevisions, scope, nextRevision);
        return true;
      });
    }
    const toolsRawKey = rawKey(toolsKey);
    const committedRevisionKey = rawKey(
      `tools:mcp:app-committed-revision:{${redisHashTag(toolsRawKey)}}`,
    );
    const written = await deps.keyvRedisClient!.eval(WRITE_APP_TOOLS_IF_CURRENT_SCRIPT, {
      keys: [committedRevisionKey, toolsRawKey],
      arguments: [
        publicationRevision,
        JSON.stringify(entry),
        String(Date.now() + ttl),
        String(ttl),
        String(ttl),
      ],
    });
    return Number(written) === 1;
  }

  /** Returns the generation this invalidation published for a user and server, so a caller that
   *  fenced its own credential mutation can tell that rotation apart from a foreign one. */
  async function invalidateCachedTools(
    options: {
      userId?: string;
      serverName?: string;
      invalidateGlobal?: boolean;
    } = {},
  ): Promise<string | undefined> {
    const cache = await getReadyCache();
    if (options.invalidateGlobal) {
      await runWithGlobalCacheLock(() => deleteGlobalWithinLock(cache));
    }
    const { userId, serverName } = options;
    if (!userId || !serverName) {
      return undefined;
    }
    return withUserQueue(userId, serverName, async () => {
      const generation = randomUUID();
      if (
        (await cache.set(
          ToolCacheKeys.MCP_SERVER_LEGACY_FENCE(userId, serverName),
          true,
          generationTtl,
        )) === false
      ) {
        throw new Error('Tool cache rejected the legacy migration fence');
      }
      if (
        (await cache.set(
          ToolCacheKeys.MCP_SERVER_GENERATION(userId, serverName),
          generation,
          generationTtl,
        )) === false
      ) {
        throw new Error('Tool publication generation cache rejected invalidation');
      }
      await cache.delete(ToolCacheKeys.MCP_SERVER(userId, serverName));
      return generation;
    });
  }

  return {
    getCachedTools,
    updateCachedGlobalTools,
    setCachedTools,
    setCachedToolsIfCurrent,
    getMCPToolsCacheGeneration,
    renewMCPToolsCacheGeneration,
    setCachedToolsWithinGlobalLock,
    getCachedAppServerTools,
    getNextAppToolsPublicationRevision,
    setCachedAppServerTools,
    runWithGlobalCacheLock,
    invalidateCachedTools,
  };
}
