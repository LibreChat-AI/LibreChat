import { createHash } from 'crypto';
import { isProcessMCPServerConfig } from 'librechat-data-provider';
import { logger, encryptV2, decryptV2, scopedCacheKey } from '@librechat/data-schemas';
import type { IServerConfigsRepositoryInterface } from './ServerConfigsRepositoryInterface';
import type { ReadThroughTransforms, FillToken } from './cache/ReadThroughAllCache';
import type * as t from '~/mcp/types';
import {
  ServerConfigsCacheFactory,
  APP_CACHE_NAMESPACE,
  CONFIG_CACHE_NAMESPACE,
} from './cache/ServerConfigsCacheFactory';
import { MCPInspectionFailedError, isMCPDomainNotAllowedError } from '~/mcp/errors';
import { normalizeLegacyHeaderMaps, normalizeLegacyHeaderMapsIn } from './compat';
import { canBackfillSharedServerInstructions, isUserSourced } from '~/mcp/utils';
import { ReadThroughAllCache } from './cache/ReadThroughAllCache';
import { isPluginSourced, MCP_PLUGIN_SOURCE } from '~/utils/env';
import { requireApiKeyReentryForRebinding } from './binding';
import { ReadThroughCache } from './cache/ReadThroughCache';
import { MCPServerInspector } from './MCPServerInspector';
import { ServerConfigsDB } from './db/ServerConfigsDB';
import { cacheConfig } from '~/cache';
import { withTimeout } from '~/utils';

/** How long a failure stub is considered fresh before re-attempting inspection (5 minutes). */
const CONFIG_STUB_RETRY_MS = 5 * 60 * 1000;

/** A request stopped while its config initialization was still queued. Healthy
 * joiners retry ownership instead of inheriting that request-local cancellation. */
export class MCPConfigInitializationCanceledError extends Error {}

/** Cached configs carry decrypted oauth/apiKey credentials, so the shared
 *  stores only ever see ciphertext; plaintext stays in process memory,
 *  exactly where it lived before these caches became shared.
 *
 *  Decoding also normalizes legacy header maps, because a replica running older
 *  code fills these stores from its own database reads: without it, a rolling
 *  deployment would keep serving a config the runtime schemas reject, from a
 *  cache hit that never reaches the repository's own normalization. */
function serverMapStoreTransforms(): ReadThroughTransforms<Record<string, t.ParsedServerConfig>> {
  return {
    encode: async (value) => encryptV2(JSON.stringify(value)),
    decode: async (raw) =>
      normalizeLegacyHeaderMapsIn(
        JSON.parse(await decryptV2(raw)) as Record<string, t.ParsedServerConfig>,
      ),
  };
}

/** The per-server cache also negative-caches lookups, so its envelope keeps a
 *  stored "absent" (null) distinguishable from "not cached". */
function perServerStoreTransforms(): ReadThroughTransforms<t.ParsedServerConfig | undefined> {
  return {
    encode: async (value) => encryptV2(JSON.stringify({ config: value ?? null })),
    decode: async (raw) => {
      const decoded = JSON.parse(await decryptV2(raw)) as {
        config: t.ParsedServerConfig | null;
      };
      return decoded.config == null ? undefined : normalizeLegacyHeaderMaps(decoded.config);
    },
  };
}

/**
 * Provenance to persist for a config being stored in `tier`.
 *
 * SECURITY INVARIANT — an Agent Plugins server keeps its own `'plugin'` marker
 * rather than taking the tier's tag. `processMCPEnv` reads that marker to decide
 * whether a `${VAR}` the plugin authored stays literal, so retagging here would
 * expand host secrets into a plugin-controlled header or URL at both inspection
 * and connect time. Only operator-loaded tiers may carry the marker: a DB entry
 * is user-authored and is always `'user'`, so user input can never claim plugin
 * provenance and skip the sandboxed placeholder rules.
 */
function resolveServerSource(
  config: t.ParsedServerConfig,
  tier: t.MCPServerSource,
): t.MCPServerSource {
  if (tier === 'user') {
    return 'user';
  }
  return isPluginSourced(config) ? MCP_PLUGIN_SOURCE : tier;
}

/**
 * Source an overlaid config should carry when a Config-tier override shadows a
 * same-name base entry. The base's source is normally inherited so downstream
 * recovery routes to the base's storage tier.
 *
 * SECURITY INVARIANT — a remote `'plugin'` base is the exception: its no-resolve
 * provenance must never transfer to an operator-authored override, or
 * `processMCPEnv` would stop resolving the operator's own `${VAR}` placeholders.
 * The override supersedes a remote plugin server, so it keeps its own trusted
 * source instead. Process-backed base entries never reach this overlay path.
 */
function overlaySource(
  base: t.ParsedServerConfig,
  override: t.ParsedServerConfig,
): t.MCPServerSource | undefined {
  if (base.source === MCP_PLUGIN_SOURCE) {
    return override.source ?? 'config';
  }
  return base.source;
}

/**
 * Fields an admin override can legitimately set. Used to detect whether a
 * resolved entry differs from its YAML base so unmodified YAML servers can
 * skip lazy-init (avoids per-request inspect storms and prevents these
 * servers from being cached in the config tier).
 */
const ADMIN_CONFIGURABLE_FIELDS = [
  'type',
  'command',
  'args',
  'env',
  'stderr',
  'url',
  'headers',
  'requestHeaders',
  'proxy',
  'requiresOAuth',
  'apiKey',
  'oauth',
  'oauth_headers',
  'obo',
  'title',
  'description',
  'iconPath',
  'startup',
  'chatMenu',
  'serverInstructions',
  'customUserVars',
  'timeout',
  'sseReadTimeout',
  'oauthRefreshWaitTimeout',
  'oauthRefreshCoordination',
  'oauthPersistenceWaitTimeout',
  'initTimeout',
] as const;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/**
 * True when `candidate` matches `yamlEntry` on every admin-configurable field.
 * Field-wise comparison rather than whole-object equality: inspector-derived
 * fields (`tools`, `updatedAt`, `resolvedInstructions`, ...) may legitimately
 * differ between a stored entry and the effective config a connection used.
 */
function matchesAdminConfigurableFields(
  yamlEntry: t.ParsedServerConfig,
  candidate: t.ParsedServerConfig,
): boolean {
  const yamlRecord = yamlEntry as unknown as Record<string, unknown>;
  const candidateRecord = candidate as unknown as Record<string, unknown>;
  return ADMIN_CONFIGURABLE_FIELDS.every((field) =>
    deepEqual(yamlRecord[field], candidateRecord[field]),
  );
}

const CONFIG_SERVER_INIT_TIMEOUT_MS = (() => {
  const raw = process.env.MCP_INIT_TIMEOUT_MS;
  if (raw == null) {
    return 30_000;
  }
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();

/** Request context for resolving the effective MCP allowlists. */
export interface MCPAllowlistContext {
  userId?: string;
  role?: string;
}

/**
 * Resolves the effective `mcpSettings` allowlists for a request. Injected from the app
 * layer (where the merged, tenant-scoped config lives) so the registry keeps no app-config
 * dependency. Reads the ALS tenant context internally; pass the acting user to also pick up
 * user/role-scoped overrides.
 */
export type MCPAllowlistResolver = (
  ctx?: MCPAllowlistContext,
) => Promise<{ allowedDomains?: string[] | null; allowedAddresses?: string[] | null }>;

/** Effective allowlists resolved for a request. */
interface ResolvedMCPAllowlists {
  allowedDomains?: string[] | null;
  allowedAddresses?: string[] | null;
}

/** The stored entry a reinspection reads and writes back to. */
interface ReinspectionTarget {
  configRepo: IServerConfigsRepositoryInterface;
  serverName: string;
  storageLocation: 'CACHE' | 'DB';
  userId?: string;
}

/**
 * Central registry for managing MCP server configurations.
 * Authoritative source of truth for all MCP servers provided by LibreChat.
 *
 * Uses a three-layer architecture:
 * - YAML Cache (cacheConfigsRepo): Operator-defined configs loaded at startup (in-memory or Redis)
 * - Config Cache (configCacheRepo): Admin-defined configs from Config overrides, lazily initialized
 * - DB Repository (dbConfigsRepo): User-provided configs created at runtime (MongoDB + ACL)
 *
 * Query priority: Config cache → YAML cache → DB.
 */
export class MCPServersRegistry {
  private static instance: MCPServersRegistry;

  private readonly dbConfigsRepo: ServerConfigsDB;
  private readonly cacheConfigsRepo: IServerConfigsRepositoryInterface;
  private readonly configCacheRepo: IServerConfigsRepositoryInterface;
  /** YAML-derived base allowlists; used at boot and as the fallback when no resolver is set. */
  private readonly allowedDomains?: string[] | null;
  private readonly allowedAddresses?: string[] | null;
  /** Resolves the per-request (tenant-scoped) merged allowlists; falls back to the base above. */
  private readonly allowlistResolver?: MCPAllowlistResolver;
  private readonly readThroughCache: ReadThroughCache<t.ParsedServerConfig | undefined>;
  private readonly readThroughCacheAll: ReadThroughAllCache<Record<string, t.ParsedServerConfig>>;
  private readonly pendingGetAllPromises = new Map<
    string,
    {
      generation: string;
      promise: Promise<Record<string, t.ParsedServerConfig>>;
    }
  >();

  /** Tracks in-flight config server initializations to prevent duplicate work. */
  private readonly pendingConfigInits = new Map<
    string,
    Promise<t.ParsedServerConfig | undefined>
  >();

  /** In-flight reinspections, shared by callers that would inspect the same stored entry
   *  under the same allowlists. */
  private readonly pendingReinspections = new Map<string, Promise<t.AddServerResult>>();

  /** The in-flight reinspection each settling flight waits on, by key, so waits never form a cycle. */
  private readonly reinspectionWaits = new Map<string, string>();

  /** Memoized YAML server names — set once after boot-time init, never changes. */
  private yamlServerNames: Set<string> | null = null;
  private yamlServerNamesPromise: Promise<Set<string>> | null = null;

  constructor(
    mongoose: typeof import('mongoose'),
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
    allowlistResolver?: MCPAllowlistResolver,
  ) {
    this.dbConfigsRepo = new ServerConfigsDB(mongoose);
    this.cacheConfigsRepo = ServerConfigsCacheFactory.create(APP_CACHE_NAMESPACE, false);
    this.configCacheRepo = ServerConfigsCacheFactory.create(CONFIG_CACHE_NAMESPACE, false);
    this.allowedDomains = allowedDomains;
    this.allowedAddresses = allowedAddresses;
    this.allowlistResolver = allowlistResolver;

    const ttl = cacheConfig.MCP_REGISTRY_CACHE_TTL;

    /** Per-server entries are invalidated by targeted deletes. */
    this.readThroughCache = new ReadThroughCache<t.ParsedServerConfig | undefined>(
      'mcp-registry-read-through',
      ttl,
      perServerStoreTransforms(),
    );

    this.readThroughCacheAll = new ReadThroughAllCache<Record<string, t.ParsedServerConfig>>(
      'mcp-registry-read-through-all',
      ttl,
      serverMapStoreTransforms(),
    );
  }

  /** Creates and initializes the singleton MCPServersRegistry instance */
  public static createInstance(
    mongoose: typeof import('mongoose'),
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
    allowlistResolver?: MCPAllowlistResolver,
  ): MCPServersRegistry {
    if (!mongoose) {
      throw new Error(
        'MCPServersRegistry creation failed: mongoose instance is required for database operations. ' +
          'Ensure mongoose is initialized before creating the registry.',
      );
    }
    if (MCPServersRegistry.instance) {
      logger.debug('[MCPServersRegistry] Returning existing instance');
      return MCPServersRegistry.instance;
    }
    logger.info('[MCPServersRegistry] Creating new instance');
    MCPServersRegistry.instance = new MCPServersRegistry(
      mongoose,
      allowedDomains,
      allowedAddresses,
      allowlistResolver,
    );
    return MCPServersRegistry.instance;
  }

  /** Returns the singleton MCPServersRegistry instance */
  public static getInstance(): MCPServersRegistry {
    if (!MCPServersRegistry.instance) {
      throw new Error('MCPServersRegistry has not been initialized.');
    }
    return MCPServersRegistry.instance;
  }

  /** YAML base allowlist (boot/fallback). For request-time decisions use {@link resolveAllowlists}. */
  public getAllowedDomains(): string[] | null | undefined {
    return this.allowedDomains;
  }

  /** YAML base allowlist (boot/fallback). For request-time decisions use {@link resolveAllowlists}. */
  public getAllowedAddresses(): string[] | null | undefined {
    return this.allowedAddresses;
  }

  /** Returns true when no explicit allowedDomains allowlist is configured, enabling SSRF TOCTOU protection */
  public shouldEnableSSRFProtection(): boolean {
    return !Array.isArray(this.allowedDomains) || this.allowedDomains.length === 0;
  }

  /**
   * Resolves the effective domain/address allowlists for the current request.
   *
   * MCP allowlists live in `mcpSettings`, which is tenant/principal-scoped admin config, so
   * they must be read per-request from the merged config — not from a process-global value
   * that would leak across tenants. The injected resolver reads the ALS tenant context; pass
   * the acting user so user/role-scoped overrides resolve too (config-source inspection has no
   * user and resolves at tenant scope). Falls back to the YAML base allowlists when no resolver
   * is injected or the resolver fails, so a transient lookup error fails to the operator's
   * baseline rather than disabling the allowlist.
   */
  public async resolveAllowlists(ctx?: MCPAllowlistContext): Promise<{
    allowedDomains?: string[] | null;
    allowedAddresses?: string[] | null;
    useSSRFProtection: boolean;
  }> {
    let allowedDomains = this.allowedDomains;
    let allowedAddresses = this.allowedAddresses;
    if (this.allowlistResolver) {
      try {
        const resolved = await this.allowlistResolver(ctx);
        allowedDomains = resolved.allowedDomains;
        allowedAddresses = resolved.allowedAddresses;
      } catch {
        logger.warn(
          '[MCPServersRegistry] Allowlist resolver failed; falling back to YAML base allowlists',
        );
      }
    }
    return {
      allowedDomains,
      allowedAddresses,
      useSSRFProtection: !Array.isArray(allowedDomains) || allowedDomains.length === 0,
    };
  }

  /**
   * Returns the config for a single server, mirroring the precedence used by
   * getAllServerConfigs so list views and single-server lookups agree on
   * the same name:
   *   1. user-tier base entry wins absolutely over a config-tier candidate
   *   2. process-backed base entries win absolutely over a config-tier candidate
   *   3. healthy YAML/DB base wins over a failed (inspectionFailed) candidate
   *   4. healthy candidate overlays its fields onto the base, preserving the
   *      base entry's source tag so downstream recovery routes correctly
   *   5. with no base, the candidate is returned as-is (config-only server)
   *
   * readThroughCache memoizes only the global YAML/DB lookup; the per-call
   * configServers candidate is tenant-scoped and is never cached, so a
   * failed stub from one tenant can never satisfy a no-userId lookup from
   * another.
   */
  public async getServerConfig(
    serverName: string,
    userId?: string,
    configServers?: Record<string, t.ParsedServerConfig>,
  ): Promise<t.ParsedServerConfig | undefined> {
    const candidate = configServers?.[serverName];

    const cacheKey = this.getReadThroughCacheKey(serverName, userId);
    let base: t.ParsedServerConfig | undefined;
    const cached = await this.readThroughCache.getEntry(cacheKey);
    if (cached.hit) {
      base = cached.value;
    } else {
      const configFromYaml = await this.cacheConfigsRepo.get(serverName);
      if (configFromYaml) {
        base = configFromYaml;
      } else {
        base = await this.dbConfigsRepo.get(serverName, userId);
      }
      await this.readThroughCache.set(cacheKey, base, cached.fill);
    }

    if (!candidate) return base;
    if (base?.source === 'user') return base;
    if (isProcessMCPServerConfig(base)) return base;
    if (candidate.inspectionFailed) return base ?? candidate;
    return base ? { ...candidate, source: overlaySource(base, candidate) } : candidate;
  }

  /** Returns whether an effective config exactly matches the operator-owned base config. */
  public async isAppServerConfig(
    serverName: string,
    effectiveConfig: t.ParsedServerConfig,
  ): Promise<boolean> {
    const baseConfig = await this.getServerConfig(serverName);
    return baseConfig != null && deepEqual(baseConfig, effectiveConfig);
  }

  /**
   * Returns the full server config map after merging YAML cache, Config-tier overrides,
   * and User-DB entries.
   *
   * Precedence (lowest to highest): YAML cache > Config-tier overrides (success only) > User DB.
   * Three guards keep the merge safe:
   *   1. Config-tier entries carrying `inspectionFailed: true` never overlay an existing
   *      base entry; the healthy base is preserved for the duration of the retry window.
   *   2. User-DB entries (`source: 'user'`) are never replaced by Config-tier overlays.
   *   3. Process-backed base entries are never replaced by Config-tier overlays.
   * On a successful overlay the base entry's `source` field is preserved so downstream
   * recovery logic routes to the correct storage location — except a `'plugin'` base,
   * whose no-resolve provenance must not transfer to the operator override (see
   * `overlaySource`).
   */
  public async getAllServerConfigs(
    userId?: string,
    configServers?: Record<string, t.ParsedServerConfig>,
    role?: string,
  ): Promise<Record<string, t.ParsedServerConfig>> {
    if (configServers == null || !Object.keys(configServers).length) {
      return this.getBaseServerConfigs(userId, role);
    }
    const base = await this.getBaseServerConfigs(userId, role);
    const result: Record<string, t.ParsedServerConfig> = { ...base };
    for (const [name, override] of Object.entries(configServers)) {
      if (result[name]?.source === 'user') {
        logger.debug('[MCP][config] Admin override shadowed by user-tier entry');
        continue;
      }
      if (isProcessMCPServerConfig(result[name])) {
        logger.debug(`[MCP][config][${name}] Admin override shadowed by process-backed entry`);
        continue;
      }
      if (override.inspectionFailed && result[name]) continue;
      const baseEntry = result[name];
      result[name] = baseEntry
        ? { ...override, source: overlaySource(baseEntry, override) }
        : override;
    }
    return result;
  }

  /**
   * Returns YAML + user-DB server configs, cached via `readThroughCacheAll`.
   * YAML wins on name collisions so a user-created server cannot hide global config.
   * Always called by `getAllServerConfigs` so the DB query is amortized across
   * requests within the TTL window regardless of whether `configServers` is present.
   */
  private async getBaseServerConfigs(
    userId?: string,
    role?: string,
  ): Promise<Record<string, t.ParsedServerConfig>> {
    /** Tenant-scoped (also covering the single-flight map): the DB read behind
     *  a miss is filtered by the active tenant, so entries and in-flight
     *  builds must partition the same way. */
    // DB visibility depends on both user and role. Keep the role in the cache and
    // single-flight identity so a role change cannot reuse the previous ACL result.
    const cacheKey = scopedCacheKey(`${userId ?? '__no_user__'}::role:${role ?? '__no_role__'}`);

    const cached = await this.readThroughCacheAll.get(cacheKey);
    if (cached.hit) {
      return cached.value ?? {};
    }

    const fill = cached.fill;
    if (fill?.generation == null) {
      return this.fetchBaseServerConfigs(cacheKey, userId, role, fill);
    }

    const pending = this.pendingGetAllPromises.get(cacheKey);
    if (pending?.generation === fill.generation) {
      return pending.promise;
    }

    const fetchPromise = this.fetchBaseServerConfigs(cacheKey, userId, role, fill);
    const pendingFill = { generation: fill.generation, promise: fetchPromise };
    this.pendingGetAllPromises.set(cacheKey, pendingFill);

    try {
      return await fetchPromise;
    } finally {
      if (this.pendingGetAllPromises.get(cacheKey) === pendingFill) {
        this.pendingGetAllPromises.delete(cacheKey);
      }
    }
  }

  private async fetchBaseServerConfigs(
    cacheKey: string,
    userId?: string,
    role?: string,
    fill?: FillToken,
  ): Promise<Record<string, t.ParsedServerConfig>> {
    const [dbConfigs, yamlConfigs] = await Promise.all([
      this.dbConfigsRepo.getAll(userId, role),
      this.cacheConfigsRepo.getAll(),
    ]);

    this.warnOnOperatorManagedNameCollisions(yamlConfigs, dbConfigs, 'YAML');

    const result = { ...dbConfigs, ...yamlConfigs };

    await this.readThroughCacheAll.set(cacheKey, result, fill);
    return result;
  }

  /**
   * Stores a minimal config stub so the server remains "known" to the registry
   * even when inspection fails at startup. This enables reinitialize to recover.
   */
  public async addServerStub(
    serverName: string,
    config: t.MCPOptions,
    storageLocation: 'CACHE',
    userId?: string,
  ): Promise<t.AddServerResult> {
    const configRepo = this.getConfigRepository(storageLocation);
    const stubConfig: t.ParsedServerConfig = {
      ...config,
      inspectionFailed: true,
      source: resolveServerSource(config, 'yaml'),
    };
    const result = await configRepo.add(serverName, stubConfig, userId);
    await this.invalidateServerReadCaches(result.serverName, userId, 'CACHE');
    this.resetYamlServerNamesMemo();
    return result;
  }

  public async addServer(
    serverName: string,
    config: t.MCPOptions,
    storageLocation: 'CACHE' | 'DB',
    userId?: string,
    reservedServerNames?: Iterable<string>,
  ): Promise<t.AddServerResult> {
    const configRepo = this.getConfigRepository(storageLocation);
    const source = resolveServerSource(config, storageLocation === 'CACHE' ? 'yaml' : 'user');
    const configForInspection = { ...config, source } as t.ParsedServerConfig;
    const { allowedDomains, allowedAddresses } = await this.resolveAllowlists({ userId });
    let parsedConfig: t.ParsedServerConfig;
    try {
      parsedConfig = await MCPServerInspector.inspect(
        serverName,
        configForInspection,
        undefined,
        allowedDomains,
        allowedAddresses,
      );
    } catch (error) {
      logger.error(`[MCPServersRegistry] Failed to inspect server "${serverName}":`, error);
      if (isMCPDomainNotAllowedError(error)) {
        throw error;
      }
      throw new MCPInspectionFailedError(serverName, error as Error);
    }
    const tagged = {
      ...parsedConfig,
      source,
    };
    const result =
      storageLocation === 'DB'
        ? await this.dbConfigsRepo.add(
            serverName,
            tagged,
            userId,
            await this.getOperatorManagedServerNames(reservedServerNames),
          )
        : await configRepo.add(serverName, tagged, userId);
    await this.invalidateServerReadCaches(result.serverName, userId, storageLocation);
    if (storageLocation === 'CACHE') {
      this.resetYamlServerNamesMemo();
    }
    return result;
  }

  /**
   * Backfills the inspector-derived `resolvedInstructions` for a server whose
   * operator explicitly deferred startup inspection. An enabled
   * `serverInstructions` declaration has no fetched text to resolve in that
   * case. Identity- or request-scoped servers are deliberately rejected:
   * their live instructions cannot safely be stored in a shared config.
   *
   * First write wins: once the stored entry carries any text, later calls are
   * no-ops. Without this, identities racing the first backfill under stale
   * config snapshots would churn the shared copy and rotate the global read
   * caches on every divergence.
   *
   * YAML-tier servers only. Config-overlay servers are cached under
   * config-hash keys and cannot be addressed by name here; DB-backed user
   * servers need an identity-preserving write through mongoose timestamps and
   * the credential-sanitization pipeline, which is its own change. Both are
   * left untouched. An overlaid effective config carries its base's `'yaml'`
   * source tag (`overlaySource`), so `connectedConfig` — the config the
   * delivering connection was actually created from — is compared against the
   * stored entry on every admin-configurable field: text fetched from an
   * overridden endpoint must never be stored as the shared base's.
   *
   * The entry's `updatedAt` is deliberately preserved (the storage `patch`
   * contract): the config identity did not change, and bumping it would mark
   * every live connection for this server stale.
   *
   * @returns true when a stored config was updated.
   */
  public async setResolvedInstructions(
    serverName: string,
    instructions: string,
    userId?: string,
    connectedConfig?: t.ParsedServerConfig,
  ): Promise<boolean> {
    if (!this.cacheConfigsRepo.patch) {
      return false;
    }
    const yamlEntry = await this.cacheConfigsRepo.get(serverName);
    if (
      !yamlEntry ||
      yamlEntry.resolvedInstructions != null ||
      !canBackfillSharedServerInstructions(yamlEntry)
    ) {
      return false;
    }
    if (connectedConfig && !matchesAdminConfigurableFields(yamlEntry, connectedConfig)) {
      logger.debug(
        `[MCPServersRegistry][${serverName}] Connection config differs from the stored YAML entry (config-tier override or stale snapshot); not storing its instructions`,
      );
      return false;
    }
    /** The identity comparison above ran against a snapshot that can lag by the
     *  registry cache TTL; passing the validated entry's `updatedAt` makes the
     *  store-side patch a compare-and-set, so instructions never land on an
     *  entry another replica replaced in between. */
    const patched = await this.cacheConfigsRepo.patch(
      serverName,
      { resolvedInstructions: instructions },
      yamlEntry.updatedAt,
    );
    if (!patched) {
      return false;
    }
    await this.invalidateServerReadCaches(serverName, userId, 'CACHE');
    return true;
  }

  /**
   * Resolves a config that failed inspection to the config a connection should be made with.
   *
   * Once the server is reachable this is the stored, inspected config — whether this call
   * recovered it or a concurrent request did, on this replica or another — so a caller that
   * read the stub connects with what inspection found rather than the stub. Resolves undefined
   * while the server is still unreachable. Config-tier stubs are left to `ensureConfigServers`,
   * which retries them on its own schedule.
   */
  public async recoverServerConfig(
    serverName: string,
    config: t.ParsedServerConfig,
    userId?: string,
  ): Promise<t.ParsedServerConfig | undefined> {
    if (!config.inspectionFailed) {
      return config;
    }
    if (config.source === 'config') {
      logger.info(
        '[MCPServersRegistry] Config-source server inspection failed; retry handled by config cache',
      );
      return undefined;
    }
    try {
      const result = await this.reinspectServer(
        serverName,
        isUserSourced(config) ? 'DB' : 'CACHE',
        userId,
      );
      return result.config;
    } catch {
      logger.info('[MCPServersRegistry] Server is still unreachable after reinspection');
      return undefined;
    }
  }

  /**
   * Re-inspects a server whose stored config failed inspection and replaces that stub with the
   * inspected config.
   *
   * Inspection is a network round trip, and every caller that read the stub before a recovery
   * was written would otherwise inspect and write again. Each write bumps `updatedAt`, which
   * marks connections made after the previous write stale, so a caller already holding one
   * reads an empty tool list. Callers in this process that read the same stub and are judged
   * against the same allowlists therefore share one inspection and one write, and the write
   * replaces only the stub that was inspected, so a replica that lost the race writes nothing.
   *
   * Every decision reads the entry past the store's process-local snapshot. An entry that is no
   * longer failed was already recovered and resolves to the stored config without another
   * inspection, including when that recovery is found only after this call's own inspection
   * failed. A stub that a registry re-initialization replaced while it was inspected resolves
   * through an inspection of the newer stub. A server that is still unreachable rejects with
   * `MCPInspectionFailedError`; an allowlist rejection is rethrown as is.
   */
  public async reinspectServer(
    serverName: string,
    storageLocation: 'CACHE' | 'DB',
    userId?: string,
  ): Promise<t.AddServerResult> {
    const target: ReinspectionTarget = {
      configRepo: this.getConfigRepository(storageLocation),
      serverName,
      storageLocation,
      userId,
    };
    const { allowedDomains, allowedAddresses } = await this.resolveAllowlists({ userId });
    const entry = await this.getReinspectionEntry(target);
    if (!entry.inspectionFailed) {
      return { serverName, config: entry };
    }
    return this.joinReinspection(target, { allowedDomains, allowedAddresses }, entry);
  }

  /**
   * Shares one inspection and write of `stub` among callers judged against the same allowlists.
   * A flight settling against another stub passes its own key as `waiter` and joins that stub's
   * flight, unless the flight already waits on the waiter; then the waiter inspects it itself.
   */
  private async joinReinspection(
    target: ReinspectionTarget,
    allowlists: ResolvedMCPAllowlists,
    stub: t.ParsedServerConfig,
    waiter?: string,
  ): Promise<t.AddServerResult> {
    const key = this.reinspectionKey(target, allowlists, stub);
    if (waiter != null && this.waitsOn(key, waiter)) {
      return this.reinspectStub(target, allowlists, stub, waiter);
    }
    const pending = this.pendingReinspections.get(key);
    const reinspection = pending ?? this.reinspectStub(target, allowlists, stub, key);
    if (!pending) {
      this.pendingReinspections.set(key, reinspection);
    }
    if (waiter != null) {
      this.reinspectionWaits.set(waiter, key);
    }
    try {
      return await reinspection;
    } finally {
      if (waiter != null && this.reinspectionWaits.get(waiter) === key) {
        this.reinspectionWaits.delete(waiter);
      }
      if (!pending && this.pendingReinspections.get(key) === reinspection) {
        this.pendingReinspections.delete(key);
      }
    }
  }

  /** Whether the flight for `key` is `waiter` or waits on it, directly or through other flights. */
  private waitsOn(key: string, waiter: string): boolean {
    for (
      let next: string | undefined = key;
      next != null;
      next = this.reinspectionWaits.get(next)
    ) {
      if (next === waiter) {
        return true;
      }
    }
    return false;
  }

  private async reinspectStub(
    target: ReinspectionTarget,
    allowlists: ResolvedMCPAllowlists,
    stub: t.ParsedServerConfig,
    flightKey: string,
  ): Promise<t.AddServerResult> {
    const { serverName, storageLocation, userId } = target;
    const { inspectionFailed: _, ...configForInspection } = stub;
    let parsedConfig: t.ParsedServerConfig;
    try {
      parsedConfig = await MCPServerInspector.inspect(
        serverName,
        configForInspection,
        undefined,
        allowlists.allowedDomains,
        allowlists.allowedAddresses,
      );
    } catch (error) {
      logger.error('[MCPServersRegistry] Server reinspection failed');
      if (isMCPDomainNotAllowedError(error)) {
        throw error;
      }
      return this.resolveStoredEntry(
        target,
        allowlists,
        stub,
        flightKey,
        new MCPInspectionFailedError(serverName, error as Error),
      );
    }

    const stored = await this.replaceStub(target, stub, parsedConfig);
    if (stored) {
      await this.invalidateServerReadCaches(serverName, userId, storageLocation);
      return { serverName, config: stored };
    }
    return this.resolveStoredEntry(
      target,
      allowlists,
      stub,
      flightKey,
      new MCPInspectionFailedError(
        serverName,
        new Error('Storage did not replace the inspected stub'),
      ),
    );
  }

  /**
   * Settles a reinspection whose own inspection did not replace `stub` against the entry stored
   * now. A recovery another writer stored is the outcome, and this replica's read caches drop
   * the stub they may still memoize from before it. A different stub from a registry
   * re-initialization is settled through its own flight, which this one joins when another
   * request already started it. A stub still in place rejects with `failure`.
   */
  private async resolveStoredEntry(
    target: ReinspectionTarget,
    allowlists: ResolvedMCPAllowlists,
    stub: t.ParsedServerConfig,
    flightKey: string,
    failure: MCPInspectionFailedError,
  ): Promise<t.AddServerResult> {
    const { serverName, storageLocation, userId } = target;
    const current = await this.getReinspectionEntry(target);
    if (!current.inspectionFailed) {
      await this.invalidateServerReadCaches(serverName, userId, storageLocation);
      return { serverName, config: current };
    }
    if (current.updatedAt === stub.updatedAt) {
      throw failure;
    }
    return this.joinReinspection(target, allowlists, current, flightKey);
  }

  private async getReinspectionEntry({
    configRepo,
    serverName,
    storageLocation,
    userId,
  }: ReinspectionTarget): Promise<t.ParsedServerConfig> {
    const entry = configRepo.getCurrent
      ? await configRepo.getCurrent(serverName, userId)
      : await configRepo.get(serverName, userId);
    if (!entry) {
      throw new Error(`Server "${serverName}" not found in ${storageLocation} for reinspection.`);
    }
    return entry;
  }

  /** Writes an inspected config over the stub it came from; undefined when another writer
   *  replaced the stub first. DB storage holds no startup stubs, so it keeps a plain update. */
  private async replaceStub(
    { configRepo, serverName, userId }: ReinspectionTarget,
    stub: t.ParsedServerConfig,
    parsedConfig: t.ParsedServerConfig,
  ): Promise<t.ParsedServerConfig | undefined> {
    if (configRepo.replaceStub) {
      return configRepo.replaceStub(serverName, parsedConfig, stub.updatedAt);
    }
    const updatedConfig = { ...parsedConfig, updatedAt: Date.now() };
    await configRepo.update(serverName, updatedConfig, userId);
    return updatedConfig;
  }

  /**
   * Identity of a reinspection: the stored stub it inspects — a DB entry is visible per user and
   * tenant — and the allowlists it is judged against, so neither a user's DB visibility nor a
   * tenant's allowlist decision reaches another caller through a shared inspection, and a newer
   * stub is never answered by an inspection of the one it replaced.
   */
  private reinspectionKey(
    { serverName, storageLocation, userId }: ReinspectionTarget,
    allowlists: ResolvedMCPAllowlists,
    stub: t.ParsedServerConfig,
  ): string {
    return JSON.stringify([
      storageLocation,
      storageLocation === 'DB' ? this.getReadThroughCacheKey(serverName, userId) : serverName,
      stub.updatedAt ?? null,
      allowlists.allowedDomains ?? null,
      allowlists.allowedAddresses ?? null,
    ]);
  }

  /**
   * Inspects an update without mutating its backing repository. Callers that must
   * coordinate an external fence with persistence can prepare first, fence, and
   * then commit the returned config.
   */
  public async inspectServerUpdate(
    serverName: string,
    config: t.MCPOptions,
    storageLocation: 'CACHE' | 'DB',
    userId?: string,
  ): Promise<t.ParsedServerConfig> {
    const configRepo = this.getConfigRepository(storageLocation);
    const source = resolveServerSource(config, storageLocation === 'CACHE' ? 'yaml' : 'user');

    // Merge an equivalent update's existing admin API key for inspection.
    let configForInspection = { ...config };
    if (config.apiKey?.source === 'admin' && !config.apiKey?.key) {
      const existingConfig = await configRepo.get(serverName, userId);
      if (existingConfig?.apiKey?.key) {
        requireApiKeyReentryForRebinding(existingConfig, config);
        configForInspection = {
          ...configForInspection,
          apiKey: {
            ...configForInspection.apiKey!,
            key: existingConfig.apiKey.key,
          },
        };
      }
    }

    const { allowedDomains, allowedAddresses } = await this.resolveAllowlists({ userId });
    let parsedConfig: t.ParsedServerConfig;
    try {
      parsedConfig = await MCPServerInspector.inspect(
        serverName,
        { ...configForInspection, source } as t.ParsedServerConfig,
        undefined,
        allowedDomains,
        allowedAddresses,
      );
    } catch (error) {
      logger.error(`[MCPServersRegistry] Failed to inspect server "${serverName}":`, error);
      if (isMCPDomainNotAllowedError(error)) {
        throw error;
      }
      throw new MCPInspectionFailedError(serverName, error as Error);
    }
    return parsedConfig;
  }

  /** Persists a previously inspected update without opening a second MCP connection. */
  public async commitServerUpdate(
    serverName: string,
    parsedConfig: t.ParsedServerConfig,
    storageLocation: 'CACHE' | 'DB',
    userId?: string,
  ): Promise<t.ParsedServerConfig> {
    const configRepo = this.getConfigRepository(storageLocation);
    await configRepo.update(serverName, parsedConfig, userId);
    await this.invalidateServerReadCaches(serverName, userId, storageLocation);
    return parsedConfig;
  }

  public async updateServer(
    serverName: string,
    config: t.MCPOptions,
    storageLocation: 'CACHE' | 'DB',
    userId?: string,
  ): Promise<t.ParsedServerConfig> {
    const parsedConfig = await this.inspectServerUpdate(
      serverName,
      config,
      storageLocation,
      userId,
    );
    return await this.commitServerUpdate(serverName, parsedConfig, storageLocation, userId);
  }

  /**
   * Ensures that config-source MCP servers (from admin Config overrides) are initialized.
   * Identifies servers in `resolvedMcpConfig` that are not from YAML, lazily initializes
   * any not yet in the config cache, and returns their parsed configs.
   *
   * Config cache keys are scoped by a hash of the raw config to prevent cross-tenant
   * cache poisoning when two tenants define a server with the same name but different configs.
   */
  public async ensureConfigServers(
    resolvedMcpConfig: Record<string, t.MCPOptions>,
    limit: <T>(task: () => Promise<T>) => Promise<T> = (task) => task(),
  ): Promise<Record<string, t.ParsedServerConfig>> {
    if (!resolvedMcpConfig || Object.keys(resolvedMcpConfig).length === 0) {
      return {};
    }

    const result: Record<string, t.ParsedServerConfig> = {};

    // Config-source servers are admin-defined with no acting user; resolve the effective
    // allowlists once at tenant scope and fold them into each config-cache key so a tenant
    // whose allowlist rejects a URL cannot poison the shared key for a tenant that allows it.
    const { allowedDomains, allowedAddresses } = await this.resolveAllowlists();
    const allowlists: ResolvedMCPAllowlists = { allowedDomains, allowedAddresses };

    /** Single snapshot of the YAML cache for the whole pass: in the Redis aggregate-key backend, every per-name get() reads and deserializes the full map, so N concurrent per-server lookups would issue N full-map reads. The snapshot also keeps the unchanged-YAML comparison consistent against one view of YAML across all entries. */
    const yamlSnapshot = await this.cacheConfigsRepo.getAll();

    const settled = await Promise.allSettled(
      Object.entries(resolvedMcpConfig).map(async ([serverName, rawConfig]) => {
        if (this.isUnmodifiedYamlServer(yamlSnapshot, serverName, rawConfig)) {
          return;
        }
        const parsed = await this.ensureSingleConfigServer(
          serverName,
          rawConfig,
          allowlists,
          limit,
        );
        if (parsed) {
          result[serverName] = parsed;
        }
      }),
    );
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        logger.error('[MCPServersRegistry][ensureConfigServers] Unexpected initialization error');
      }
    }

    return result;
  }

  /**
   * Returns true when `rawConfig` matches the YAML cache entry for this server
   * on every admin-configurable field, so an unmodified YAML-defined server
   * can skip lazy-init and avoid being re-inspected or shadowed in the
   * config tier.
   */
  private isUnmodifiedYamlServer(
    yamlSnapshot: Record<string, t.ParsedServerConfig>,
    serverName: string,
    rawConfig: t.MCPOptions,
  ): boolean {
    const yamlEntry = yamlSnapshot[serverName];
    if (!yamlEntry || yamlEntry.source !== 'yaml') {
      return false;
    }
    const yamlRecord = yamlEntry as unknown as Record<string, unknown>;
    const rawRecord = rawConfig as unknown as Record<string, unknown>;
    /** rawConfig is the pre-inspection MCPOptions; absent fields mean the admin didn't override and shouldn't count as a diff against inspector-derived values on the cached YAML entry. */
    return ADMIN_CONFIGURABLE_FIELDS.every((field) => {
      const rawVal = rawRecord[field];
      if (rawVal === undefined) return true;
      return deepEqual(yamlRecord[field], rawVal);
    });
  }

  /**
   * Ensures a single config-source server is initialized.
   * Cache key is scoped by config hash to prevent cross-tenant poisoning.
   * Deduplicates concurrent init requests for the same server+config.
   * Stale failure stubs are retried after `CONFIG_STUB_RETRY_MS` to recover from transient errors.
   */
  private async ensureSingleConfigServer(
    serverName: string,
    rawConfig: t.MCPOptions,
    allowlists: ResolvedMCPAllowlists,
    limit: <T>(task: () => Promise<T>) => Promise<T>,
  ): Promise<t.ParsedServerConfig | undefined> {
    const cacheKey = this.configCacheKey(serverName, rawConfig, allowlists);

    const cached = await this.configCacheRepo.get(cacheKey);
    if (cached) {
      const isStaleStub =
        cached.inspectionFailed && Date.now() - (cached.updatedAt ?? 0) > CONFIG_STUB_RETRY_MS;
      if (!isStaleStub) {
        return cached;
      }
      logger.info('[MCP][config] Retrying stale failure stub');
    }

    const pending = this.pendingConfigInits.get(cacheKey);
    if (pending) {
      try {
        return await pending;
      } catch (error) {
        if (error instanceof MCPConfigInitializationCanceledError) {
          return this.ensureSingleConfigServer(serverName, rawConfig, allowlists, limit);
        }
        throw error;
      }
    }

    // Only the caller that owns the cold initialization consumes shared capacity.
    // Joiners await the single-flight promise directly instead of filling every
    // slot while the same inspection runs once.
    const initPromise = limit(() =>
      this.lazyInitConfigServer(cacheKey, serverName, rawConfig, allowlists),
    );
    this.pendingConfigInits.set(cacheKey, initPromise);

    try {
      return await initPromise;
    } finally {
      this.pendingConfigInits.delete(cacheKey);
    }
  }

  /**
   * Lazily initializes a config-source MCP server: inspects capabilities/tools, then
   * stores the parsed config in the config cache with `source: 'config'`.
   */
  private async lazyInitConfigServer(
    cacheKey: string,
    serverName: string,
    rawConfig: t.MCPOptions,
    allowlists: ResolvedMCPAllowlists,
  ): Promise<t.ParsedServerConfig | undefined> {
    const prefix = '[MCP][config]';
    logger.info(`${prefix} Lazy-initializing config-source server`);

    const source = resolveServerSource(rawConfig, 'config');

    try {
      const configForInspection = { ...rawConfig, source } as t.ParsedServerConfig;
      const { allowedDomains, allowedAddresses } = allowlists;
      const inspected = await withTimeout(
        MCPServerInspector.inspect(
          serverName,
          configForInspection,
          undefined,
          allowedDomains,
          allowedAddresses,
        ),
        CONFIG_SERVER_INIT_TIMEOUT_MS,
        `${prefix} Server initialization timed out`,
      );

      const parsedConfig: t.ParsedServerConfig = { ...inspected, source };
      await this.upsertConfigCache(cacheKey, parsedConfig);

      logger.info(
        `${prefix} Initialized: toolCount=${parsedConfig.toolFunctions ? Object.keys(parsedConfig.toolFunctions).length : 0}, ` +
          `duration=${parsedConfig.initDuration ?? 'N/A'}ms`,
      );
      return parsedConfig;
    } catch {
      logger.error(`${prefix} Failed to initialize`);

      const stubConfig: t.ParsedServerConfig = {
        ...rawConfig,
        inspectionFailed: true,
        source,
        updatedAt: Date.now(),
      };
      try {
        await this.upsertConfigCache(cacheKey, stubConfig);
        logger.info(`${prefix} Stored stub config for recovery`);
      } catch {
        logger.error(`${prefix} Failed to store stub config; will retry on next request`);
      }
      return stubConfig;
    }
  }

  /**
   * Writes a config to `configCacheRepo` using the atomic upsert operation.
   * Safe for cross-process races — the underlying cache handles add-or-update internally.
   */
  private async upsertConfigCache(cacheKey: string, config: t.ParsedServerConfig): Promise<void> {
    await this.configCacheRepo.upsert(cacheKey, config);
  }

  /**
   * Clears the config-source server cache, forcing re-inspection on next access.
   * Called when admin config overrides change (e.g., mcpServers mutation).
   *
   * @returns Names of servers that were evicted from the config cache.
   *          Callers should disconnect active connections for these servers.
   */
  public async invalidateConfigCache(): Promise<string[]> {
    const allCached = await this.configCacheRepo.getAll();
    const evictedNames = [
      ...new Set(Object.keys(allCached).map((key) => this.parseServerNameFromConfigCacheKey(key))),
    ];

    await Promise.all([
      this.configCacheRepo.reset(),
      // Only invalidate readThroughCacheAll (merged results that may include stale config servers).
      // readThroughCache (individual YAML/user lookups) is unaffected by config mutations.
      // Operator config changes are global, so the eviction crosses tenants.
      this.readThroughCacheAll.invalidateAllGlobal(),
    ]);

    if (evictedNames.length > 0) {
      logger.info(
        `[MCPServersRegistry] Config server cache invalidated, evicted: ${evictedNames.join(', ')}`,
      );
    }
    return evictedNames;
  }

  // TODO: Refactor callers to use config.requiresOAuth directly instead of this method.
  // Known gap: config-source OAuth servers are not included here because callers
  // (OAuthReconnectionManager, UserController) lack request context to resolve configServers.
  // Config-source OAuth auto-reconnection and uninstall cleanup require a separate mechanism.
  public async getOAuthServers(userId?: string): Promise<Set<string>> {
    const allServers = await this.getAllServerConfigs(userId);
    const oauthServers = Object.entries(allServers).filter(([, config]) => config.requiresOAuth);
    return new Set(oauthServers.map(([name]) => name));
  }

  public async reset(): Promise<void> {
    await this.cacheConfigsRepo.reset();
    await this.configCacheRepo.reset();
    await this.readThroughCache.clear();
    await this.readThroughCacheAll.invalidateAllGlobal();
    this.resetYamlServerNamesMemo();
  }

  public async removeServer(
    serverName: string,
    storageLocation: 'CACHE' | 'DB',
    userId?: string,
  ): Promise<void> {
    const configRepo = this.getConfigRepository(storageLocation);
    await configRepo.remove(serverName, userId);
    await this.invalidateServerReadCaches(serverName, userId, storageLocation);
    if (storageLocation === 'CACHE') {
      this.resetYamlServerNamesMemo();
    }
  }

  private getConfigRepository(storageLocation: 'CACHE' | 'DB'): IServerConfigsRepositoryInterface {
    switch (storageLocation) {
      case 'CACHE':
        return this.cacheConfigsRepo;
      case 'DB':
        return this.dbConfigsRepo;
      default:
        throw new Error(
          `MCPServersRegistry: The provided storage location "${storageLocation}" is not supported`,
        );
    }
  }

  /** Tenant-scoped because DB-backed lookups are filtered by the active tenant:
   *  an entry populated in one tenant's context must never satisfy another's. */
  private getReadThroughCacheKey(serverName: string, userId?: string): string {
    return scopedCacheKey(userId ? `${serverName}::${userId}` : serverName);
  }

  /**
   * DB-backed servers and their ACL grants are tenant-scoped data, so their
   * invalidation stays within the acting tenant. CACHE-tier (YAML/App
   * repository) entries are global, so those mutations evict across tenants:
   * the per-server cache cannot enumerate tenant-scoped keys, so it clears the
   * namespace, and the aggregate map uses its global path.
   */
  private async invalidateServerReadCaches(
    serverName: string,
    userId?: string,
    storageLocation?: 'CACHE' | 'DB',
  ): Promise<void> {
    if (storageLocation === 'CACHE') {
      await Promise.all([
        this.readThroughCache.clear(),
        this.readThroughCacheAll.invalidateAllGlobal(),
      ]);
      return;
    }

    const deletes = [
      this.readThroughCache.delete(this.getReadThroughCacheKey(serverName)),
      this.readThroughCacheAll.invalidateAll(),
    ];

    if (userId) {
      deletes.push(this.readThroughCache.delete(this.getReadThroughCacheKey(serverName, userId)));
    }

    await Promise.all(deletes);
  }

  private async getOperatorManagedServerNames(
    reservedServerNames: Iterable<string> = [],
  ): Promise<string[]> {
    const yamlNames = await this.getYamlServerNames();

    return [...new Set([...yamlNames, ...reservedServerNames])];
  }

  private parseServerNameFromConfigCacheKey(cacheKey: string): string {
    const lastColon = cacheKey.lastIndexOf(':');
    return lastColon > 0 ? cacheKey.slice(0, lastColon) : cacheKey;
  }

  private warnOnOperatorManagedNameCollisions(
    operatorConfigs: Record<string, t.ParsedServerConfig>,
    candidateConfigs: Record<string, t.ParsedServerConfig>,
    operatorSource: 'Config' | 'YAML',
  ): void {
    const shadowedNames = Object.keys(operatorConfigs).filter(
      (serverName) => candidateConfigs[serverName]?.source === 'user',
    );
    if (!shadowedNames.length) {
      return;
    }

    logger.warn(
      `[MCPServersRegistry] ${operatorSource} MCP server(s) shadow DB-backed servers with ${shadowedNames.length} colliding name(s); DB records remain stored but hidden`,
    );
  }

  private resetYamlServerNamesMemo(): void {
    this.yamlServerNames = null;
    this.yamlServerNamesPromise = null;
  }

  /**
   * Returns memoized YAML server names. Populated lazily on first call after boot/reset.
   * YAML servers don't change after boot, so this avoids repeated `getAll()` calls.
   * Uses promise deduplication to prevent concurrent cold-start double-fetch.
   */
  private getYamlServerNames(): Promise<Set<string>> {
    if (this.yamlServerNames) {
      return Promise.resolve(this.yamlServerNames);
    }
    if (this.yamlServerNamesPromise) {
      return this.yamlServerNamesPromise;
    }
    this.yamlServerNamesPromise = this.cacheConfigsRepo
      .getAll()
      .then((configs) => {
        this.yamlServerNames = new Set(Object.keys(configs));
        this.yamlServerNamesPromise = null;
        return this.yamlServerNames;
      })
      .catch((err) => {
        this.yamlServerNamesPromise = null;
        throw err;
      });
    return this.yamlServerNamesPromise;
  }

  /**
   * Produces a config-cache key scoped by server name AND a hash of the raw config plus the
   * effective allowlists. Hashing the raw config prevents cross-tenant poisoning when two
   * tenants define the same server name with different configurations; hashing the allowlists
   * prevents poisoning when the same config resolves differently because tenants have different
   * `mcpSettings.allowedDomains` / `allowedAddresses` (so one tenant's inspection result — e.g.
   * an `inspectionFailed` stub from a rejected domain — never satisfies another tenant's lookup).
   */
  private configCacheKey(
    serverName: string,
    rawConfig: t.MCPOptions,
    allowlists?: ResolvedMCPAllowlists,
  ): string {
    const payload = {
      rawConfig,
      allowedDomains: allowlists?.allowedDomains ?? null,
      allowedAddresses: allowlists?.allowedAddresses ?? null,
    };
    const sorted = JSON.stringify(payload, (_key, value: unknown) => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        );
      }
      return value;
    });
    const hash = createHash('sha256').update(sorted).digest('hex').slice(0, 16);
    return `${serverName}:${hash}`;
  }
}
