import {
  PrincipalType,
  materializeModelSpecEndpoints,
  setMaxSubagents,
} from 'librechat-data-provider';
import {
  logger,
  getTenantId,
  mergeConfigOverrides,
  BASE_CONFIG_PRINCIPAL_ID,
} from '@librechat/data-schemas';
import type { AppConfig, IConfig } from '@librechat/data-schemas';
import type { Types } from 'mongoose';
import type { CustomConfigLoadMode } from './loader';

const BASE_CONFIG_KEY = '_BASE_';

export type AppConfigPrincipal = {
  principalType: string;
  principalId?: string | Types.ObjectId;
};

/**
 * Materializes inferable model-spec fields (an omitted `preset.endpoint` for
 * agent specs) so every consumer of the effective config reads complete specs.
 * Runs at both assembly points — YAML base load and DB-override merge — because
 * override documents contribute specs the base config never saw.
 */
function materializeConfigModelSpecs(config: AppConfig): AppConfig {
  const modelSpecs = materializeModelSpecEndpoints(config.modelSpecs);
  if (modelSpecs === config.modelSpecs) {
    return config;
  }
  return { ...config, modelSpecs };
}

export const DEFAULT_OVERRIDE_CACHE_TTL = 60_000;

// ── Types ────────────────────────────────────────────────────────────

interface CacheStore {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, ttl?: number) => Promise<unknown>;
  delete: (key: string) => Promise<boolean>;
  /** Keyv options — used for key enumeration when clearing override caches. */
  opts?: {
    store?: {
      keys?: () => IterableIterator<string>;
    };
  };
}

export interface AppConfigServiceDeps {
  /** Load the base AppConfig from YAML + AppService processing. */
  loadBaseConfig: (mode?: CustomConfigLoadMode) => Promise<AppConfig | undefined>;
  /** Cache tools after base config is loaded. */
  setCachedTools: (tools: Record<string, unknown>) => Promise<void>;
  /** Get a cache store by key. */
  getCache: (key: string) => CacheStore;
  /** The CacheKeys constants from librechat-data-provider. */
  cacheKeys: { APP_CONFIG: string };
  /** Fetch applicable DB config overrides for a set of principals. */
  getApplicableConfigs: (principals?: AppConfigPrincipal[]) => Promise<IConfig[]>;
  /** Resolve full principal list (user + role + groups) from userId/role. */
  getUserPrincipals: (params: {
    userId: string | Types.ObjectId;
    role?: string | null;
    idOnTheSource?: string | null;
  }) => Promise<AppConfigPrincipal[]>;
  /** Add mutable principal-scoped runtime configuration after cached overrides are resolved. */
  augmentConfig?: (context: {
    appConfig: AppConfig;
    baseConfig: AppConfig;
    principals: AppConfigPrincipal[];
    options: GetAppConfigOptions;
  }) => Promise<AppConfig>;
  /** TTL in ms for per-user/role merged config caches. Defaults to 60 000. */
  overrideCacheTtl?: number;
}

export interface GetAppConfigOptions {
  role?: string;
  userId?: string;
  idOnTheSource?: string | null;
  tenantId?: string;
  refresh?: boolean;
  /** When true, return only the YAML-derived base config — no DB override queries. */
  baseOnly?: boolean;
  /** Propagate principal, override, and augmentation failures for security-sensitive callers. */
  failClosed?: boolean;
  /** Reuse principals already resolved by another authorization query in the same request. */
  resolvedPrincipals?: AppConfigPrincipal[];
  /** Skip mutable runtime augmentation when the caller has already loaded that data. */
  skipRuntimeAugmentation?: boolean;
}

export interface AppConfigUserLike {
  /** Resolved app user id. */
  id?: string;
  role?: string;
  tenantId?: string;
  idOnTheSource?: string | null;
}

export function getAppConfigOptionsFromUser(
  user?: AppConfigUserLike | null,
  tenantId?: string,
): GetAppConfigOptions {
  const userId = user?.id;
  const hasSourceIdentity =
    user != null && Object.prototype.hasOwnProperty.call(user, 'idOnTheSource');
  return {
    role: user?.role,
    userId,
    idOnTheSource: userId && hasSourceIdentity ? (user.idOnTheSource ?? null) : undefined,
    tenantId: tenantId ?? user?.tenantId ?? getTenantId(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

let _strictOverride: boolean | undefined;
function isStrictOverrideMode(): boolean {
  return (_strictOverride ??= process.env.TENANT_ISOLATION_STRICT === 'true');
}

let _warnedNoTenantInStrictMode = false;

/** @internal Resets the memoized strict-override flag and one-time no-tenantId warning gate. Exposed for test teardown only. */
export function _resetOverrideStrictCache(): void {
  _strictOverride = undefined;
  _warnedNoTenantInStrictMode = false;
}

function overrideCacheKey(role?: string, userId?: string, tenantId?: string): string {
  // Fall back to the ALS tenant context before `__default__`: callers that rely on the
  // tenant middleware (the common path) pass no explicit tenantId, so without this the
  // entry is keyed under the shared `__default__` bucket and leaks across tenants.
  const tenant = tenantId || getTenantId() || '__default__';
  if (userId) {
    if (role) {
      return `_OVERRIDE_:${tenant}:${role}:${userId}`;
    }
    return `_OVERRIDE_:${tenant}:${userId}`;
  }
  if (role) {
    return `_OVERRIDE_:${tenant}:${role}`;
  }
  return `_OVERRIDE_:${tenant}:${BASE_CONFIG_PRINCIPAL_ID}`;
}

// ── Service factory ──────────────────────────────────────────────────

export function createAppConfigService(deps: AppConfigServiceDeps): {
  getAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
  clearAppConfigCache: () => Promise<void>;
  clearOverrideCache: (tenantId?: string) => Promise<void>;
} {
  const {
    loadBaseConfig,
    setCachedTools,
    getCache,
    cacheKeys,
    getApplicableConfigs,
    getUserPrincipals,
    augmentConfig,
    overrideCacheTtl = DEFAULT_OVERRIDE_CACHE_TTL,
  } = deps;

  const cache = getCache(cacheKeys.APP_CONFIG);
  let lastGoodBaseConfig: AppConfig | undefined;
  let baseConfigFlight: Promise<AppConfig> | undefined;

  async function buildPrincipals(
    role?: string,
    userId?: string,
    idOnTheSource?: string | null,
  ): Promise<AppConfigPrincipal[]> {
    if (userId) {
      const params: { userId: string; role?: string | null; idOnTheSource?: string | null } = {
        userId,
        role,
      };
      if (idOnTheSource !== undefined) {
        params.idOnTheSource = idOnTheSource;
      }
      return getUserPrincipals(params);
    }
    const principals: AppConfigPrincipal[] = [];
    if (role) {
      principals.push({ principalType: PrincipalType.ROLE, principalId: role });
    }
    return principals;
  }

  async function restoreLastGoodBaseConfig(error: unknown): Promise<AppConfig> {
    const lastGood = lastGoodBaseConfig;
    if (!lastGood) {
      throw error;
    }

    setMaxSubagents(lastGood.config?.endpoints?.agents?.maxSubagents);
    logger.error(
      '[ensureBaseConfig] Failed to reload base configuration; keeping the last good configuration.',
      error,
    );
    const restorations = [cache.set(BASE_CONFIG_KEY, lastGood)];
    if (lastGood.availableTools) {
      restorations.push(setCachedTools(lastGood.availableTools));
    }
    const results = await Promise.allSettled(restorations);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error('[ensureBaseConfig] Failed to restore last-good config state:', result.reason);
      }
    }
    return lastGood;
  }

  async function loadAndCacheBaseConfig(mode: CustomConfigLoadMode): Promise<AppConfig> {
    try {
      logger.info('[ensureBaseConfig] Loading base configuration...');
      const loaded = await loadBaseConfig(mode);
      if (!loaded) {
        throw new Error('Failed to initialize app configuration through AppService.');
      }

      const baseConfig = materializeConfigModelSpecs(loaded);
      if (baseConfig.availableTools) {
        await setCachedTools(baseConfig.availableTools);
      }
      await cache.set(BASE_CONFIG_KEY, baseConfig);
      lastGoodBaseConfig = baseConfig;
      return baseConfig;
    } catch (error) {
      if (mode === 'startup') {
        throw error;
      }
      return restoreLastGoodBaseConfig(error);
    }
  }

  /**
   * Ensure the YAML-derived base config is loaded and cached.
   * Returns the `_BASE_` config (YAML + AppService). No DB queries.
   */
  async function ensureBaseConfig(refresh?: boolean): Promise<AppConfig> {
    const cached = (await cache.get(BASE_CONFIG_KEY)) as AppConfig | undefined;
    if (cached) {
      lastGoodBaseConfig ??= cached;
      if (!refresh) {
        return cached;
      }
    }

    if (baseConfigFlight) {
      return baseConfigFlight;
    }

    const mode: CustomConfigLoadMode = lastGoodBaseConfig ? 'reload' : 'startup';
    const flight = loadAndCacheBaseConfig(mode);
    baseConfigFlight = flight;
    try {
      return await flight;
    } finally {
      if (baseConfigFlight === flight) {
        baseConfigFlight = undefined;
      }
    }
  }

  /**
   * Get the app configuration, optionally merged with DB overrides for the given principal.
   *
   * The base config (from YAML + AppService) is cached indefinitely. Per-principal merged
   * configs are cached with a short TTL (`overrideCacheTtl`, default 60s). On cache miss,
   * `getApplicableConfigs` queries the DB for matching overrides and merges them by priority.
   *
   * When `baseOnly` is true, returns the YAML-derived config without any DB queries.
   * `role`, `userId`, and `tenantId` are ignored in this mode.
   * Use this for startup, auth strategies, and other pre-tenant code paths.
   */
  async function getAppConfig(options: GetAppConfigOptions = {}): Promise<AppConfig> {
    const {
      role,
      userId,
      idOnTheSource,
      tenantId,
      refresh,
      baseOnly,
      failClosed,
      resolvedPrincipals,
      skipRuntimeAugmentation,
    } = options;

    const baseConfig = await ensureBaseConfig(refresh);

    if (baseOnly) {
      return baseConfig;
    }

    const principals =
      resolvedPrincipals ??
      (await buildPrincipals(role, userId, idOnTheSource).catch((error: unknown) => {
        if (failClosed) throw error;
        logger.error('[getAppConfig] Error building principals, falling back to base:', error);
        return null;
      }));
    if (principals === null) {
      return baseConfig;
    }

    // Strict isolation + no tenant anywhere (neither param nor ALS) is pathological: a
    // middleware bypass or an unauthenticated startup call. Pre-tenant calls should use
    // baseOnly:true and admin calls carry an explicit tenantId. Return the base config
    // without caching it under the shared `__default__` bucket. When ALS has a tenant,
    // overrideCacheKey scopes the key to it, so we fall through and cache per-tenant.
    if (principals.length === 0 && !tenantId && !getTenantId() && isStrictOverrideMode()) {
      return baseConfig;
    }

    if (!tenantId && !getTenantId() && isStrictOverrideMode() && !_warnedNoTenantInStrictMode) {
      _warnedNoTenantInStrictMode = true;
      logger.warn(
        '[getAppConfig] No tenantId in strict mode — falling back to __default__. ' +
          'This likely indicates a code path that bypasses the tenant context middleware.',
      );
    }

    const augment = async (appConfig: AppConfig): Promise<AppConfig> => {
      if (augmentConfig == null || skipRuntimeAugmentation === true) return appConfig;
      try {
        return await augmentConfig({ appConfig, baseConfig, principals, options });
      } catch (error) {
        if (failClosed) throw error;
        logger.error('[getAppConfig] Error augmenting principal config:', error);
        return appConfig;
      }
    };

    const cacheKey = overrideCacheKey(role, userId, tenantId);
    if (!refresh) {
      const cachedMerged = (await cache.get(cacheKey)) as AppConfig | undefined;
      if (cachedMerged) {
        return await augment(cachedMerged);
      }
    }

    let merged = baseConfig;
    try {
      const configs = await getApplicableConfigs(principals);
      if (configs.length > 0) {
        merged = materializeConfigModelSpecs(mergeConfigOverrides(baseConfig, configs));
      }
    } catch (error) {
      if (failClosed) throw error;
      logger.error('[getAppConfig] Error resolving config overrides, falling back to base:', error);
      return baseConfig;
    }

    await cache.set(cacheKey, merged, overrideCacheTtl);
    return await augment(merged);
  }

  /**
   * Clear the base config cache. Per-user/role override caches (`_OVERRIDE_:*`)
   * are NOT flushed — they expire naturally via `overrideCacheTtl`. After calling this,
   * the base config will be reloaded from YAML on the next `getAppConfig` call, but
   * users with cached overrides may see stale merged configs for up to `overrideCacheTtl` ms.
   */
  async function clearAppConfigCache(): Promise<void> {
    await cache.delete(BASE_CONFIG_KEY);
  }

  /**
   * Clear per-principal override caches. When `tenantId` is provided, only caches
   * matching `_OVERRIDE_:${tenantId}:*` are deleted. When omitted, ALL override
   * caches are cleared.
   */
  async function clearOverrideCache(tenantId?: string): Promise<void> {
    const namespace = cacheKeys.APP_CONFIG;
    const overrideSegment = tenantId ? `_OVERRIDE_:${tenantId}:` : '_OVERRIDE_:';

    // In-memory store — enumerate keys directly.
    // APP_CONFIG defaults to FORCED_IN_MEMORY_CACHE_NAMESPACES, so this is the
    // standard path. Redis SCAN is intentionally avoided here — it can cause 60s+
    // stalls under concurrent load (see #12410). When APP_CONFIG is Redis-backed
    // and store.keys() is unavailable, overrides expire naturally via TTL.
    const store = (cache as CacheStore).opts?.store;
    if (store && typeof store.keys === 'function') {
      // Keyv stores keys with a namespace prefix (e.g. "APP_CONFIG:_OVERRIDE_:...").
      // We match on the namespaced key but delete using the un-namespaced key
      // because Keyv.delete() auto-prepends the namespace.
      const namespacedPrefix = `${namespace}:${overrideSegment}`;
      const toDelete: string[] = [];
      for (const key of store.keys()) {
        if (key.startsWith(namespacedPrefix)) {
          toDelete.push(key.slice(namespace.length + 1));
        }
      }
      if (toDelete.length > 0) {
        await Promise.all(toDelete.map((key) => cache.delete(key)));
        logger.info(
          `[clearOverrideCache] Cleared ${toDelete.length} override cache entries` +
            (tenantId ? ` for tenant ${tenantId}` : ''),
        );
      }
      return;
    }

    logger.warn(
      '[clearOverrideCache] Cache store does not support key enumeration. ' +
        'Override caches will expire naturally via TTL (%dms). ' +
        'This is expected when APP_CONFIG is Redis-backed — Redis SCAN is avoided ' +
        'for performance reasons (see #12410).',
      overrideCacheTtl,
    );
  }

  return {
    getAppConfig,
    clearAppConfigCache,
    clearOverrideCache,
  };
}

export type AppConfigService = ReturnType<typeof createAppConfigService>;
