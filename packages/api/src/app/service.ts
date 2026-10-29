import { createHash } from 'node:crypto';
import {
  PrincipalType,
  materializeModelSpecEndpoints,
  normalizeEndpointName,
  setMaxSubagents,
} from 'librechat-data-provider';
import {
  logger,
  getTenantId,
  tenantStorage,
  deriveSpecInterface,
  SPEC_INTERFACE_FIELDS,
  BASE_CONFIG_PRINCIPAL_ID,
  SYSTEM_TENANT_ID,
} from '@librechat/data-schemas';
import type {
  AppConfig,
  SpecInterfaceField,
  ConfigOverrideLayer,
  ConfigLayerResolution,
  AdminConfigLayerIgnored,
} from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { CustomConfigLoadMode, ConfigLoadFailure, ConfigLoadResult } from './loader';
import type { EnvReferencePolicy } from './allowlist';
import type { SecretRebinding } from './rebinding';
import { resolveOverrideLayers, mergeOverrideLayersWithSource } from './overrides';
import { createEnvReferencePolicy, parseEnvAllowlist } from './allowlist';
import { resolveRuntimeConfigSecrets } from '~/admin/secrets';
import { normalizeEndpointReferences } from './references';
import { getConfigLoadFailure } from './loader';
import { checkAppConfigTheme } from './theme';

const BASE_CONFIG_KEY = '_BASE_';

/** A base-config load: the config it serves, and why it failed when that is the last good one. */
interface BaseConfigLoad {
  config: AppConfig;
  failure?: ConfigLoadFailure;
}

function hiddenCustomEndpoints(
  config: AppConfig,
  tenantId?: string,
  inherited?: ReadonlySet<string>,
): Set<string> {
  const hidden = new Set(inherited);
  const custom = config.endpoints?.custom;
  const sourceCustom = config.config?.endpoints?.custom;
  for (const endpoints of [custom, sourceCustom]) {
    for (const endpoint of endpoints ?? []) {
      if (endpoint.tenantId && endpoint.tenantId !== tenantId) {
        hidden.add(normalizeEndpointName(endpoint.name ?? ''));
      }
    }
  }
  for (const endpoint of custom ?? sourceCustom ?? []) {
    const name = normalizeEndpointName(endpoint.name ?? '');
    if ((!endpoint.tenantId || endpoint.tenantId === tenantId) && !inherited?.has(name)) {
      hidden.delete(name);
    }
  }
  return hidden;
}

function scopeEndpointList<T extends { name?: string; tenantId?: string }>(
  endpoints: T[] | undefined,
  tenantId: string | undefined,
  hiddenEndpoints: ReadonlySet<string>,
): T[] | undefined {
  if (!endpoints) return endpoints;
  const tenantNames = new Set<string>();
  const scoped = endpoints.filter((endpoint) => {
    const name = normalizeEndpointName(endpoint.name ?? '');
    if ((endpoint.tenantId && endpoint.tenantId !== tenantId) || hiddenEndpoints.has(name)) {
      return false;
    }
    if (endpoint.tenantId) tenantNames.add(name);
    return true;
  });
  const selected =
    tenantNames.size === 0
      ? scoped
      : scoped.filter(
          (endpoint) =>
            endpoint.tenantId || !tenantNames.has(normalizeEndpointName(endpoint.name ?? '')),
        );
  return selected.length === endpoints.length ? endpoints : selected;
}

/** `names` without the hidden endpoints; the same array when it names none. */
function withoutHiddenNames<T extends string>(
  names: T[] | undefined,
  hiddenEndpoints: ReadonlySet<string>,
): T[] | undefined {
  const kept = names?.filter((name) => !hiddenEndpoints.has(normalizeEndpointName(name)));
  return kept?.length === names?.length ? names : kept;
}

/**
 * An endpoint allow-list (`modelSpecs.addedEndpoints`, `endpoints.agents.allowedProviders`)
 * without the hidden endpoints, kept as it is when it names nothing else: an empty list allows
 * every endpoint, while names the principal is not served allow none.
 */
function scopeAllowList<T extends string>(
  names: T[] | undefined,
  hiddenEndpoints: ReadonlySet<string>,
): T[] | undefined {
  const kept = withoutHiddenNames(names, hiddenEndpoints);
  return kept?.length === 0 ? names : kept;
}

/**
 * `specs` without the specs that select a hidden endpoint, and with `addedEndpoints` scoped by
 * `scopeAddedEndpoints`. Collapses to `undefined` only when no spec and no added endpoint is left.
 */
function scopeModelSpecs(
  specs: AppConfig['modelSpecs'],
  hiddenEndpoints: ReadonlySet<string>,
  scopeAddedEndpoints: typeof withoutHiddenNames = withoutHiddenNames,
): AppConfig['modelSpecs'] {
  if (!specs || hiddenEndpoints.size === 0) {
    return specs;
  }
  const list = specs.list?.filter(
    (spec) => !hiddenEndpoints.has(normalizeEndpointName(spec.preset?.endpoint ?? '')),
  );
  const addedEndpoints = scopeAddedEndpoints(specs.addedEndpoints, hiddenEndpoints);
  if (list?.length === specs.list?.length && addedEndpoints === specs.addedEndpoints) {
    return specs;
  }
  if (specs.list?.length && list?.length === 0 && !addedEndpoints?.length) {
    return undefined;
  }
  return { ...specs, list, addedEndpoints };
}

/** Adds the folded name of each entry in `endpoints` that `served` lacks to `hidden`. */
function addUnservedEndpointNames(
  endpoints: ReadonlyArray<{ name?: string } | null> | undefined,
  served: ReadonlySet<string>,
  hidden: Set<string>,
): void {
  if (!Array.isArray(endpoints)) {
    return;
  }
  for (const endpoint of endpoints) {
    const name = typeof endpoint?.name === 'string' ? normalizeEndpointName(endpoint.name) : '';
    if (name !== '' && !served.has(name)) {
      hidden.add(name);
    }
  }
}

/**
 * The folded names of the custom endpoints the merge removed: ones librechat.yaml or any applied
 * override layer (Base included) defines that the merged config no longer serves.
 */
function getUnservedEndpointNames(
  base: AppConfig,
  layers: readonly ConfigOverrideLayer[],
  merged: AppConfig,
): Set<string> {
  const served = new Set(
    (merged.endpoints?.custom ?? []).map((endpoint) => normalizeEndpointName(endpoint.name ?? '')),
  );
  const hidden = new Set<string>();
  addUnservedEndpointNames(base.endpoints?.custom, served, hidden);
  for (const layer of layers) {
    addUnservedEndpointNames(layer.overrides?.endpoints?.custom, served, hidden);
  }
  return hidden;
}

/** The parts of a config that name endpoints, in the served config and its YAML-shaped resolution alike. */
interface EndpointReferences {
  modelSpecs?: AppConfig['modelSpecs'];
  endpoints?: { agents?: { allowedProviders?: string[] } };
}

/**
 * `config` without its references to the `hidden` endpoints: the model specs that select one,
 * and its name in `modelSpecs.addedEndpoints` and `endpoints.agents.allowedProviders`. Unrelated
 * added endpoints stay when no spec is left, and an allow-list naming only hidden endpoints stays
 * as it is ({@link scopeAllowList}).
 */
function scopeEndpointReferences<T extends EndpointReferences>(
  config: T,
  hidden: ReadonlySet<string>,
): T {
  const agents = config.endpoints?.agents;
  const modelSpecs = scopeModelSpecs(config.modelSpecs, hidden, scopeAllowList);
  const allowedProviders = scopeAllowList(agents?.allowedProviders, hidden);
  const agentsChanged = allowedProviders !== agents?.allowedProviders;
  if (modelSpecs === config.modelSpecs && !agentsChanged) {
    return config;
  }
  return {
    ...config,
    ...(modelSpecs !== config.modelSpecs && { modelSpecs }),
    ...(agentsChanged && {
      endpoints: { ...config.endpoints, agents: { ...agents, allowedProviders } },
    }),
  };
}

/**
 * `merged` without the references to custom endpoints the merge removed
 * ({@link getUnservedEndpointNames}). A profile that hides an endpoint (a keyed
 * `endpoints.custom["Name"]` tombstone, or a tombstone of all of them) also hides the model specs
 * that select it and its name in `modelSpecs.addedEndpoints` and
 * `endpoints.agents.allowedProviders`, rather than offering its principals an endpoint they are
 * not served. Only the references are scoped, never the endpoint list, so an endpoint a later
 * layer adds back keeps them.
 */
function scopeHiddenEndpointReferences(
  base: AppConfig,
  layers: readonly ConfigOverrideLayer[],
  merged: AppConfig,
): AppConfig {
  if (!merged.modelSpecs && !merged.endpoints?.agents?.allowedProviders?.length) {
    return merged;
  }
  return scopeEndpointReferences(merged, getUnservedEndpointNames(base, layers, merged));
}

/** Keep tenant-scoped YAML endpoints out of every other tenant's effective config. */
function scopeCustomEndpoints(
  config: AppConfig,
  tenantId?: string,
  inherited?: ReadonlySet<string>,
): AppConfig {
  const hiddenEndpoints = hiddenCustomEndpoints(config, tenantId, inherited);
  const custom = config.endpoints?.custom;
  const scoped = scopeEndpointList(custom, tenantId, hiddenEndpoints);
  const sourceCustom = config.config?.endpoints?.custom;
  const scopedSource = scopeEndpointList(sourceCustom, tenantId, hiddenEndpoints);
  const modelSpecs = scopeModelSpecs(config.modelSpecs, hiddenEndpoints);
  const sourceModelSpecs = scopeModelSpecs(config.config?.modelSpecs, hiddenEndpoints);
  if (
    scoped === custom &&
    scopedSource === sourceCustom &&
    modelSpecs === config.modelSpecs &&
    sourceModelSpecs === config.config?.modelSpecs
  ) {
    return config;
  }
  return {
    ...config,
    ...(modelSpecs !== config.modelSpecs && { modelSpecs }),
    ...(scoped !== custom && { endpoints: { ...config.endpoints, custom: scoped } }),
    ...((scopedSource !== sourceCustom || sourceModelSpecs !== config.config?.modelSpecs) && {
      config: {
        ...config.config,
        ...(scopedSource !== sourceCustom && {
          endpoints: { ...config.config.endpoints, custom: scopedSource },
        }),
        ...(sourceModelSpecs !== config.config?.modelSpecs && { modelSpecs: sourceModelSpecs }),
      },
    }),
  };
}

/** What decides the spec-dependent interface controls: whether specs are served, and added endpoints. */
function getSpecState(modelSpecs: AppConfig['modelSpecs']): string {
  const hasSpecs = (modelSpecs?.list?.length ?? 0) > 0;
  return `${hasSpecs}:${(modelSpecs?.addedEndpoints?.length ?? 0) > 0}`;
}

/**
 * The spec-dependent interface controls a merge may have changed against `base`, whose own are
 * already derived for the specs it serves: all of them when the specs served change, else those
 * whose final librechat.yaml-shaped value (`explicit`) or served value differs from `base`'s. A
 * control a layer sets and a higher layer tombstones is back to librechat.yaml's value in
 * `explicit`, but the tombstone removed its served value, so it is derived again too.
 */
function getChangedSpecFields(
  base: AppConfig,
  merged: AppConfig,
  explicit: TCustomConfig['interface'] | undefined,
): SpecInterfaceField[] {
  if (getSpecState(base.modelSpecs) !== getSpecState(merged.modelSpecs)) {
    return [...SPEC_INTERFACE_FIELDS];
  }
  const written = base.config?.interface;
  return SPEC_INTERFACE_FIELDS.filter(
    (field) =>
      explicit?.[field] !== written?.[field] ||
      merged.interfaceConfig?.[field] !== base.interfaceConfig?.[field],
  );
}

/**
 * `config` with the interface controls model specs decide (`deriveSpecInterface`) derived for the
 * specs it serves, where `explicit` (the librechat.yaml-shaped interface) leaves them unset: the
 * `fields` given, all three by default.
 */
function withSpecInterface(
  config: AppConfig,
  explicit: TCustomConfig['interface'] | undefined,
  fields: readonly SpecInterfaceField[] = SPEC_INTERFACE_FIELDS,
): AppConfig {
  if (fields.length === 0) {
    return config;
  }
  const interfaceConfig = deriveSpecInterface(config.interfaceConfig, explicit, config.modelSpecs, {
    fields,
  });
  return interfaceConfig === config.interfaceConfig ? config : { ...config, interfaceConfig };
}

/** Re-derive only spec-dependent controls before principal overrides are applied. */
function scopeBaseConfig(config: AppConfig, tenantId?: string): AppConfig {
  const scoped = scopeCustomEndpoints(config, tenantId);
  if (scoped.modelSpecs === config.modelSpecs) {
    return scoped;
  }
  return withSpecInterface(scoped, scoped.config?.interface);
}

export type AppConfigPrincipal = {
  principalType: string;
  principalId?: string | Types.ObjectId;
};

/**
 * Applies the loader's theme rules to a theme a DB override replaced. Unknown colors are left
 * out as they are for the YAML theme; an override theme the client would reject counts as unset,
 * so the principal keeps the base theme instead of losing its theme to a bad override.
 */
function checkOverrideTheme(baseConfig: AppConfig, merged: AppConfig): AppConfig {
  const baseTheme = baseConfig.interfaceConfig?.theme;
  if (merged.interfaceConfig?.theme === baseTheme) {
    return merged;
  }
  const { appConfig, errors, warnings } = checkAppConfigTheme(merged);
  if (warnings.length > 0) {
    logger.warn(
      '[getAppConfig] interface.theme from a config override names tokens this version ignores:\n' +
        warnings.map((warning) => `- ${warning}`).join('\n'),
    );
  }
  if (errors.length === 0) {
    return appConfig;
  }
  logger.warn(
    '[getAppConfig] Ignoring interface.theme from a config override; the base theme applies instead:\n' +
      errors.map((error) => `- ${error}`).join('\n'),
  );
  return { ...merged, interfaceConfig: { ...merged.interfaceConfig, theme: baseTheme } };
}

function toLayerIgnored(
  segments: string[],
  reason: AdminConfigLayerIgnored['reason'],
): AdminConfigLayerIgnored {
  return { path: segments.join('.'), segments, reason };
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function entryName(value: unknown, field: string): string | undefined {
  const name =
    value != null && typeof value === 'object' ? (value as Record<string, unknown>)[field] : null;
  return typeof name === 'string' ? name : undefined;
}

/**
 * A librechat.yaml-shaped resolution with the theme `checkOverrideTheme` set back: when the
 * served merge fell back to the base theme because an override's theme fails the client's
 * rules, the resolution shows librechat.yaml's theme, and the last layer that wrote one says so.
 */
function replayThemeFallback(
  resolved: Partial<TCustomConfig>,
  layers: ConfigLayerResolution[],
  yaml: Partial<TCustomConfig>,
): Partial<TCustomConfig> {
  const writer = [...layers]
    .reverse()
    .find(({ layer }) => (layer.overrides as Partial<TCustomConfig>)?.interface?.theme != null);
  writer?.ignored.push(toLayerIgnored(['interface', 'theme'], 'invalid_theme'));
  const { theme: _rejected, ...rest } = resolved.interface ?? {};
  const theme = yaml.interface?.theme;
  return {
    ...resolved,
    interface: theme === undefined ? rest : { ...rest, theme },
  } as Partial<TCustomConfig>;
}

/**
 * A librechat.yaml-shaped resolution scoped to the tenant as `scopeCustomEndpoints` scopes the
 * served merge: custom endpoints `hidden` names, or another tenant's, are left out, with the
 * model specs that use them, and each layer that wrote one of those says so.
 */
function scopeResolvedEndpoints(
  resolved: Partial<TCustomConfig>,
  layers: ConfigLayerResolution[],
  tenantId: string | undefined,
  hidden: ReadonlySet<string>,
): Partial<TCustomConfig> {
  const custom = resolved.endpoints?.custom;
  const scoped = scopeEndpointList(custom, tenantId, hidden);
  const modelSpecs = scopeModelSpecs(resolved.modelSpecs as AppConfig['modelSpecs'], hidden);
  if (scoped === custom && modelSpecs === resolved.modelSpecs) {
    return resolved;
  }
  const kept = new Set(scoped ?? []);
  const removed = new Set(
    (custom ?? [])
      .filter((endpoint) => !kept.has(endpoint))
      .map((endpoint) => normalizeEndpointName(endpoint.name ?? '')),
  );
  const isHidden = (name: string | undefined) =>
    name != null &&
    (removed.has(normalizeEndpointName(name)) || hidden.has(normalizeEndpointName(name)));
  for (const { layer, ignored } of layers) {
    const overrides = layer.overrides as Partial<TCustomConfig> | undefined;
    asList(overrides?.endpoints?.custom).forEach((entry, index) => {
      if (isHidden(entryName(entry, 'name'))) {
        ignored.push(toLayerIgnored(['endpoints', 'custom', String(index)], 'tenant_hidden'));
      }
    });
    asList(overrides?.modelSpecs?.list).forEach((spec, index) => {
      const preset = (spec as { preset?: unknown } | null)?.preset;
      if (isHidden(entryName(preset, 'endpoint'))) {
        ignored.push(toLayerIgnored(['modelSpecs', 'list', String(index)], 'tenant_hidden'));
      }
    });
  }
  return {
    ...resolved,
    ...(scoped !== custom && { endpoints: { ...resolved.endpoints, custom: scoped } }),
    ...(modelSpecs !== resolved.modelSpecs && { modelSpecs }),
  } as Partial<TCustomConfig>;
}

/**
 * Materializes inferable model-spec fields (an omitted `preset.endpoint` for
 * agent specs) so every consumer of the effective config reads complete specs.
 */
function materializeConfigModelSpecs(config: AppConfig): AppConfig {
  const modelSpecs = materializeModelSpecEndpoints(config.modelSpecs);
  if (modelSpecs === config.modelSpecs) {
    return config;
  }
  return { ...config, modelSpecs };
}

/**
 * Completes the effective config: inferred spec endpoints, and endpoint references in the
 * names the runtime serves. Runs at both assembly points — YAML base load and DB-override
 * merge — because override documents contribute specs and references the base never saw.
 */
function completeEffectiveConfig(config: AppConfig): AppConfig {
  return normalizeEndpointReferences(materializeConfigModelSpecs(config));
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
  getApplicableConfigs: (principals?: AppConfigPrincipal[]) => Promise<ConfigOverrideLayer[]>;
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
  /**
   * Extra env names override values may reference (`CONFIG_OVERRIDE_ENV_ALLOWLIST`: names
   * separated by commas or whitespace), beyond those librechat.yaml references and the built-in
   * endpoint credentials.
   */
  overrideEnvAllowlist?: string;
  /**
   * Whether config overrides of Azure `groups`, Vertex AI (`endpoints.anthropic.vertex`) and the
   * Azure Assistants switch derive the served endpoints again (`CONFIG_REDERIVE_ENDPOINTS=true`).
   * Off, those overrides stay inert, as before.
   */
  rederiveEndpoints?: boolean;
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
  /**
   * Merge the overrides as stored now, neither reading nor writing the per-principal merged
   * cache. Admin reads use it so they never show a merge from before their own write. Unlike
   * `refresh`, the YAML base config is not reloaded.
   */
  bypassOverrideCache?: boolean;
}

/** What `resolveConfigLayers` resolves: one set of override documents, as `getAppConfig` merges them. */
export interface ResolveConfigLayersOptions {
  tenantId?: string;
  /** The documents to merge, active ones only, as `getApplicableConfigs` returns them. */
  configs: readonly ConfigOverrideLayer[];
}

/** A merge of override documents, served and in librechat.yaml shape, and what each layer lost. */
export interface ResolvedConfigLayers {
  /**
   * librechat.yaml as the tenant sees it (the raw config, without YAML custom endpoints and
   * model specs scoped to another tenant): what every layer merges over.
   */
  yaml: Partial<TCustomConfig>;
  /**
   * What `getAppConfig` serves for these documents, before runtime augmentation, with stored
   * secrets as stored (not decrypted).
   */
  merged: AppConfig;
  /** The same merge in librechat.yaml shape. */
  resolved: Partial<TCustomConfig>;
  /** Each document, in merge order, with what the merge does not apply of it. */
  layers: ConfigLayerResolution[];
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

/**
 * A route that decides policy from the resolved configuration must not be handed the base
 * configuration when principal or override resolution fails, because the base can be broader
 * than the scope that should have decided. The caller supplies the reader, so the selection
 * of that policy lives here rather than in the middleware that assigns the result.
 */
export function resolveStrictAppConfig(
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>,
  user?: AppConfigUserLike | null,
): Promise<AppConfig | undefined> {
  return getAppConfig({ ...getAppConfigOptionsFromUser(user), failClosed: true });
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

/** Versioned so older heads cannot supply override entries built under a stale tenant ID. */
function overrideCacheKey(
  role: string | undefined,
  userId: string | undefined,
  tenantId: string | undefined,
  scopeVersion: string,
): string {
  const tenant = tenantId ? `${tenantId}:tenant` : '__default__:global';
  const principal =
    userId && role ? `${role}:${userId}` : userId || role || BASE_CONFIG_PRINCIPAL_ID;
  return `_OVERRIDE_:${tenant}:${principal}:tenant-v1:${scopeVersion}`;
}

/**
 * Per-host late binding for method adapters constructed before the config service. The service
 * installs its reader during composition; no module-global registry or cached budget is involved.
 */
export function createMessageBudgetReader(): {
  initialize: (reader: (options?: GetAppConfigOptions) => Promise<AppConfig>) => void;
  getBudget: () => Promise<number | undefined>;
} {
  let readConfig: ((options?: GetAppConfigOptions) => Promise<AppConfig>) | undefined;
  return {
    initialize(reader) {
      readConfig = reader;
    },
    async getBudget() {
      if (!readConfig) throw new Error('Message App budget reader has not been initialized');
      const config = await readConfig({ baseOnly: true });
      return config.mcpAppSandbox?.maxPersistedMessageBytes;
    },
  };
}

/** Most distinct rebinding warnings remembered before the record starts over. */
const MAX_REBINDING_WARNINGS = 1000;

/**
 * Logs each secret a layer drops for being sent somewhere other than where it was entered, and
 * each destination it sets back, once per principal and path for the process's lifetime
 * (bounded), since every uncached merge does it again.
 */
function createRebindingWarner(): (rebinding: SecretRebinding) => void {
  const warned = new Set<string>();
  return ({ layer, kind, path }) => {
    const principal = `${layer.principalType}/${layer.principalId?.toString()}`;
    const key = `${principal}:${path}`;
    if (warned.has(key)) {
      return;
    }
    if (warned.size >= MAX_REBINDING_WARNINGS) {
      warned.clear();
    }
    warned.add(key);
    if (kind === 'destination') {
      logger.warn(
        `[getAppConfig] Ignoring "${path}" for ${principal}: it would send a credential to a destination that was not chosen for it`,
      );
      return;
    }
    logger.warn(
      `[getAppConfig] Dropping secret "${path}" for ${principal}: the merged config sends it somewhere other than the destination it was entered for`,
    );
  };
}

// ── Service factory ──────────────────────────────────────────────────

export function createAppConfigService(deps: AppConfigServiceDeps): {
  getAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
  /** One set of override documents merged as `getAppConfig` merges them, layer by layer. */
  resolveConfigLayers: (options: ResolveConfigLayersOptions) => Promise<ResolvedConfigLayers>;
  clearAppConfigCache: () => Promise<void>;
  clearOverrideCache: (tenantId?: string) => Promise<void>;
  /** Loads librechat.yaml again on this instance and resolves with the outcome; never rejects. */
  reloadBaseConfig: () => Promise<ConfigLoadResult>;
  /** The TTL in ms this service caches per-principal merged configs for. */
  overrideCacheTtl: number;
  /** Whether this service derives Azure groups, Vertex AI and Azure Assistants again. */
  rederiveEndpoints: boolean;
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
    overrideEnvAllowlist,
    rederiveEndpoints = false,
  } = deps;

  const cache = getCache(cacheKeys.APP_CONFIG);
  const envAllowlist = parseEnvAllowlist(overrideEnvAllowlist);
  const envPolicies = new WeakMap<AppConfig, Map<string, EnvReferencePolicy>>();
  const warnRebinding = createRebindingWarner();
  const runtimeConfigs = new WeakMap<AppConfig, AppConfig>();

  /**
   * A merged config with its stored credentials decrypted for runtime readers. The override cache
   * (shared through Redis when `APP_CONFIG` is not kept in memory) holds the config as merged,
   * with ciphertext; each read decrypts it, once per cached object.
   */
  function withRuntimeSecrets(merged: AppConfig): AppConfig {
    let resolved = runtimeConfigs.get(merged);
    if (!resolved) {
      resolved = resolveRuntimeConfigSecrets(merged);
      runtimeConfigs.set(merged, resolved);
    }
    return resolved;
  }

  /**
   * The env reference policy for a tenant, built once per loaded librechat.yaml and tenant from
   * the YAML that tenant sees, so a name only another tenant's endpoint references is not
   * allowed in this tenant's overrides.
   */
  function getEnvPolicy(
    baseConfig: AppConfig,
    scopedBaseConfig: AppConfig,
    tenantId: string | undefined,
  ): EnvReferencePolicy {
    let byTenant = envPolicies.get(baseConfig);
    if (!byTenant) {
      byTenant = new Map();
      envPolicies.set(baseConfig, byTenant);
    }
    const key = tenantId ?? '';
    let policy = byTenant.get(key);
    if (!policy) {
      policy = createEnvReferencePolicy({
        config: scopedBaseConfig.config,
        allowlist: envAllowlist,
      });
      byTenant.set(key, policy);
    }
    return policy;
  }
  let lastGoodBaseConfig: AppConfig | undefined;
  let baseConfigFlight: { promise: Promise<BaseConfigLoad>; generation: number } | undefined;

  /**
   * Base-config generation: `clearAppConfigCache` bumps it before deleting `_BASE_`. A reload
   * publishes its result (the cached base, the tools and the last good config) only if no clear
   * happened while it ran, and a read after a clear never joins a reload started before it, so a
   * reload that read the old librechat.yaml cannot re-cache it after a later write's clear.
   */
  let baseGeneration = 0;

  /**
   * Override-cache generations: a clear bumps the cleared tenant's (or, for a clear of every
   * tenant, the global) counter before deleting entries. A merge captures the generation, base
   * generation included, before it reads the base config or the database, and is cached only if
   * no clear happened meanwhile, so a request that read just before an admin write cannot
   * re-cache the old merge, or a merge built on the old base, just after the write's clears.
   * The check runs again once the write lands, since an async store can apply it after a
   * clear's delete.
   */
  let globalOverrideGeneration = 0;
  const tenantOverrideGenerations = new Map<string, number>();

  function getOverrideGeneration(tenantId: string | undefined): string {
    const tenant = tenantId ? (tenantOverrideGenerations.get(tenantId) ?? 0) : 0;
    return `${baseGeneration}:${globalOverrideGeneration}:${tenant}`;
  }

  function bumpOverrideGeneration(tenantId: string | undefined): void {
    if (!tenantId) {
      globalOverrideGeneration += 1;
      return;
    }
    tenantOverrideGenerations.set(tenantId, (tenantOverrideGenerations.get(tenantId) ?? 0) + 1);
  }

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

  async function restoreLastGoodBaseConfig(error: unknown, generation: number): Promise<AppConfig> {
    const lastGood = lastGoodBaseConfig;
    if (!lastGood) {
      throw error;
    }

    setMaxSubagents(lastGood.config?.endpoints?.agents?.maxSubagents);
    logger.error(
      '[ensureBaseConfig] Failed to reload base configuration; keeping the last good configuration.',
      error,
    );
    if (generation !== baseGeneration) {
      return lastGood;
    }
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
    if (generation !== baseGeneration) {
      await cache.delete(BASE_CONFIG_KEY).catch((deleteError: unknown) => {
        logger.error('[ensureBaseConfig] Failed to drop an overtaken restoration:', deleteError);
      });
    }
    return lastGood;
  }

  /**
   * Loads the base config and, unless a clear made `generation` stale while it loaded, publishes
   * it. A stale load still answers the reads that joined it, which started before the clear.
   * An async store (Redis) can land the write after a clear's delete, so a write a clear
   * overtook in flight is removed again.
   */
  async function publishBaseConfig(
    mode: CustomConfigLoadMode,
    generation: number,
  ): Promise<AppConfig> {
    logger.info('[ensureBaseConfig] Loading base configuration...');
    const loaded = await loadBaseConfig(mode);
    if (!loaded) {
      throw new Error('Failed to initialize app configuration through AppService.');
    }

    const baseConfig = completeEffectiveConfig(loaded);
    if (generation !== baseGeneration) {
      return baseConfig;
    }
    if (baseConfig.availableTools) {
      await setCachedTools(baseConfig.availableTools);
    }
    if (generation !== baseGeneration) {
      return baseConfig;
    }
    await cache.set(BASE_CONFIG_KEY, baseConfig);
    if (generation !== baseGeneration) {
      await cache.delete(BASE_CONFIG_KEY);
      return baseConfig;
    }
    lastGoodBaseConfig = baseConfig;
    return baseConfig;
  }

  /** `publishBaseConfig`, keeping the last good config, and saying why, when a reload fails. */
  async function loadAndCacheBaseConfig(
    mode: CustomConfigLoadMode,
    generation: number,
  ): Promise<BaseConfigLoad> {
    try {
      return { config: await publishBaseConfig(mode, generation) };
    } catch (error) {
      if (mode === 'startup') {
        throw error;
      }
      const config = await restoreLastGoodBaseConfig(error, generation);
      return { config, failure: getConfigLoadFailure(error) };
    }
  }

  /**
   * Reads join the load in flight for the current generation. A load for a newer generation
   * starts once the stale one settles, so the loader's process-wide side effects (such as the
   * subagent cap) end with the newest librechat.yaml rather than whichever read finished last.
   */
  async function loadBase(refresh?: boolean): Promise<BaseConfigLoad> {
    const cached = (await cache.get(BASE_CONFIG_KEY)) as AppConfig | undefined;
    if (cached) {
      lastGoodBaseConfig ??= cached;
      if (!refresh) {
        return { config: cached };
      }
    }

    const generation = baseGeneration;
    const previous = baseConfigFlight;
    if (previous?.generation === generation) {
      return previous.promise;
    }

    const mode: CustomConfigLoadMode = lastGoodBaseConfig ? 'reload' : 'startup';
    const load = () => loadAndCacheBaseConfig(mode, generation);
    const promise = previous ? previous.promise.then(load, load) : load();
    const flight = { promise, generation };
    baseConfigFlight = flight;
    try {
      return await promise;
    } finally {
      if (baseConfigFlight === flight) {
        baseConfigFlight = undefined;
      }
    }
  }

  /**
   * Ensure the YAML-derived base config is loaded and cached.
   * Returns the `_BASE_` config (YAML + AppService). No DB queries.
   */
  async function ensureBaseConfig(refresh?: boolean): Promise<AppConfig> {
    return (await loadBase(refresh)).config;
  }

  /**
   * Loads librechat.yaml again on this instance (or joins the load of it in flight), as the next
   * read after `clearAppConfigCache` would, and resolves with the outcome instead of only logging
   * a failure, so the admin reload route can answer for it. A failed load keeps the last good
   * config, as every reload does. Never rejects.
   */
  async function reloadBaseConfig(): Promise<ConfigLoadResult> {
    try {
      const { failure } = await loadBase(true);
      return failure ? { ok: false, error: failure } : { ok: true };
    } catch (error) {
      logger.error('[reloadBaseConfig] Failed to load the base configuration:', error);
      return { ok: false, error: getConfigLoadFailure(error) };
    }
  }

  /**
   * Get the app configuration, optionally merged with DB overrides for the given principal.
   *
   * The base config (from YAML + AppService) is cached indefinitely. Per-principal merged
   * configs are cached with a short TTL (`overrideCacheTtl`, default 60s). On cache miss,
   * `getApplicableConfigs` queries the DB for matching overrides, which merge in precedence
   * order (`compareConfigPrecedence`): Base first, then ascending priority, then role < group <
   * user, then document identity, the last layer winning.
   *
   * When `baseOnly` is true, returns the YAML-derived config without any DB queries.
   * `role` and `userId` are ignored; tenantId still scopes YAML custom endpoints.
   * Use this for startup and other paths that must not read overrides; sign-in decisions
   * read the `__base__` override through `resolvePreAuthAppConfig`.
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
      bypassOverrideCache,
    } = options;

    const ambientTenantId = getTenantId();
    const requestedTenantId = tenantId === SYSTEM_TENANT_ID ? undefined : tenantId;
    const effectiveTenantId =
      ambientTenantId && ambientTenantId !== SYSTEM_TENANT_ID ? ambientTenantId : requestedTenantId;
    if (effectiveTenantId && effectiveTenantId !== ambientTenantId) {
      return tenantStorage.run({ ...tenantStorage.getStore(), tenantId: effectiveTenantId }, () =>
        getAppConfig(options),
      );
    }

    const cacheTenantId = ambientTenantId ?? effectiveTenantId;
    const generation = getOverrideGeneration(cacheTenantId);
    const baseConfig = await ensureBaseConfig(refresh);
    const scopedBaseConfig = scopeBaseConfig(baseConfig, effectiveTenantId);
    const hiddenEndpoints = hiddenCustomEndpoints(baseConfig, effectiveTenantId);
    if (baseOnly) {
      return scopedBaseConfig;
    }

    const principals =
      resolvedPrincipals ??
      (await buildPrincipals(role, userId, idOnTheSource).catch((error: unknown) => {
        if (failClosed) throw error;
        logger.error('[getAppConfig] Error building principals, falling back to base:', error);
        return null;
      }));
    if (principals === null) {
      return scopedBaseConfig;
    }

    // Strict isolation + no tenant anywhere (neither param nor ALS): a middleware bypass,
    // or a signed-out request that named no tenant (strict mode refuses config reads without
    // one). Admin calls carry an explicit tenantId. Return the base config
    // without caching it under the shared `__default__` bucket. When ALS has a tenant,
    // overrideCacheKey scopes the key to it, so we fall through and cache per-tenant.
    if (principals.length === 0 && !tenantId && !getTenantId() && isStrictOverrideMode()) {
      return scopedBaseConfig;
    }

    if (!tenantId && !getTenantId() && isStrictOverrideMode() && !_warnedNoTenantInStrictMode) {
      _warnedNoTenantInStrictMode = true;
      logger.warn(
        '[getAppConfig] No tenantId in strict mode — falling back to __default__. ' +
          'This likely indicates a code path that bypasses the tenant context middleware.',
      );
    }

    const augment = async (appConfig: AppConfig): Promise<AppConfig> => {
      const scopedConfig = scopeCustomEndpoints(appConfig, effectiveTenantId, hiddenEndpoints);
      if (augmentConfig == null || skipRuntimeAugmentation === true) return scopedConfig;
      try {
        return scopeCustomEndpoints(
          await augmentConfig({
            appConfig: scopedConfig,
            baseConfig: scopedBaseConfig,
            principals,
            options: { ...options, tenantId: effectiveTenantId },
          }),
          effectiveTenantId,
          hiddenEndpoints,
        );
      } catch (error) {
        if (failClosed) throw error;
        logger.error('[getAppConfig] Error augmenting principal config:', error);
        return scopedConfig;
      }
    };

    const scopeVersion = createHash('sha256')
      .update(
        JSON.stringify([
          baseConfig.endpoints?.custom?.map(({ name, tenantId }) => [name, tenantId]),
          baseConfig.config?.endpoints?.custom?.map(({ name, tenantId }) => [name, tenantId]),
        ]),
      )
      .digest('hex');
    const cacheKey = overrideCacheKey(role, userId, cacheTenantId, scopeVersion);
    /**
     * The key names a role and user, not a principal set: principals resolved elsewhere are
     * cached only when a user id ties them to the key.
     */
    const cacheable = bypassOverrideCache !== true && (resolvedPrincipals == null || !!userId);
    if (cacheable && !refresh) {
      const cachedMerged = (await cache.get(cacheKey)) as AppConfig | undefined;
      if (cachedMerged) {
        return await augment(withRuntimeSecrets(cachedMerged));
      }
    }

    let merged = scopedBaseConfig;
    try {
      const configs = await getApplicableConfigs(principals);
      if (configs.length > 0) {
        const { appConfig: layered, raw } = mergeOverrideLayersWithSource(
          scopedBaseConfig,
          configs,
          {
            envPolicy: getEnvPolicy(baseConfig, scopedBaseConfig, effectiveTenantId),
            onRebinding: warnRebinding,
            rederiveEndpoints,
          },
        );
        const scopedMerge = scopeCustomEndpoints(
          checkOverrideTheme(
            scopedBaseConfig,
            scopeHiddenEndpointReferences(
              scopedBaseConfig,
              configs,
              completeEffectiveConfig(layered),
            ),
          ),
          effectiveTenantId,
          hiddenEndpoints,
        );
        /** Spec-dependent controls follow the specs served once tenant scoping has settled them. */
        merged = withSpecInterface(
          scopedMerge,
          raw.interface,
          getChangedSpecFields(scopedBaseConfig, scopedMerge, raw.interface),
        );
      }
    } catch (error) {
      if (failClosed) throw error;
      logger.error('[getAppConfig] Error resolving config overrides, falling back to base:', error);
      return scopedBaseConfig;
    }

    if (cacheable && getOverrideGeneration(cacheTenantId) === generation) {
      await cache.set(cacheKey, merged, overrideCacheTtl);
      if (getOverrideGeneration(cacheTenantId) !== generation) {
        await cache.delete(cacheKey);
      }
    }
    return await augment(withRuntimeSecrets(merged));
  }

  /**
   * Merges `configs` exactly as `getAppConfig` merges a principal's documents (the same base
   * config, tenant scoping, env policy and secret rebinding, theme check and endpoint scoping),
   * never reading or writing the override cache, and reports the merge in librechat.yaml shape
   * with what each layer could not apply (`resolveOverrideLayers`). Admin reads use it to show
   * what a profile, or a user, resolves to. The YAML-shaped result replays the theme fallback and
   * the tenant scoping; spec endpoint materialization and endpoint reference normalization rename
   * values for the runtime and are left out of it, as are the interface defaults AppService
   * derives.
   */
  async function resolveConfigLayers(
    options: ResolveConfigLayersOptions,
  ): Promise<ResolvedConfigLayers> {
    const { tenantId, configs } = options;
    const ambientTenantId = getTenantId();
    const requestedTenantId = tenantId === SYSTEM_TENANT_ID ? undefined : tenantId;
    const effectiveTenantId =
      ambientTenantId && ambientTenantId !== SYSTEM_TENANT_ID ? ambientTenantId : requestedTenantId;
    if (effectiveTenantId && effectiveTenantId !== ambientTenantId) {
      return tenantStorage.run({ ...tenantStorage.getStore(), tenantId: effectiveTenantId }, () =>
        resolveConfigLayers(options),
      );
    }

    const baseConfig = await ensureBaseConfig();
    const scopedBaseConfig = await scopeBaseConfig(baseConfig, effectiveTenantId);
    const yaml: Partial<TCustomConfig> = scopedBaseConfig.config ?? {};
    if (configs.length === 0) {
      return { yaml, merged: scopedBaseConfig, resolved: yaml, layers: [] };
    }
    const hiddenEndpoints = hiddenCustomEndpoints(baseConfig, effectiveTenantId);
    const resolution = resolveOverrideLayers(scopedBaseConfig, configs, {
      envPolicy: getEnvPolicy(baseConfig, scopedBaseConfig, effectiveTenantId),
      onRebinding: warnRebinding,
      rederiveEndpoints,
    });
    const completed = completeEffectiveConfig(resolution.merged);
    const unserved = getUnservedEndpointNames(scopedBaseConfig, configs, completed);
    const checked = checkOverrideTheme(
      scopedBaseConfig,
      scopeEndpointReferences(completed, unserved),
    );
    const baseTheme = scopedBaseConfig.interfaceConfig?.theme;
    let resolved = resolution.resolved;
    if (
      checked.interfaceConfig?.theme === baseTheme &&
      completed.interfaceConfig?.theme !== baseTheme
    ) {
      resolved = replayThemeFallback(resolved, resolution.layers, yaml);
    }
    resolved = scopeResolvedEndpoints(
      scopeEndpointReferences(resolved, unserved),
      resolution.layers,
      effectiveTenantId,
      hiddenCustomEndpoints(checked, effectiveTenantId, hiddenEndpoints),
    );
    const scopedMerge = scopeCustomEndpoints(checked, effectiveTenantId, hiddenEndpoints);
    const explicit = resolution.raw.interface;
    return {
      yaml,
      merged: withSpecInterface(
        scopedMerge,
        explicit,
        getChangedSpecFields(scopedBaseConfig, scopedMerge, explicit),
      ),
      resolved,
      layers: resolution.layers,
    };
  }

  /**
   * Clear the base config cache. Per-user/role override caches (`_OVERRIDE_:*`)
   * are NOT flushed — they expire naturally via `overrideCacheTtl`. After calling this,
   * the base config will be reloaded from YAML on the next `getAppConfig` call, but
   * users with cached overrides may see stale merged configs for up to `overrideCacheTtl` ms.
   * Reloads and merges already in flight are not cached afterwards.
   */
  async function clearAppConfigCache(): Promise<void> {
    baseGeneration += 1;
    await cache.delete(BASE_CONFIG_KEY);
  }

  /**
   * Clear per-principal override caches. When `tenantId` is provided, only caches
   * matching `_OVERRIDE_:${tenantId}:tenant:*` are deleted. When omitted, ALL override
   * caches are cleared.
   */
  async function clearOverrideCache(tenantId?: string): Promise<void> {
    bumpOverrideGeneration(tenantId);
    const namespace = cacheKeys.APP_CONFIG;
    const overrideSegment = tenantId ? `_OVERRIDE_:${tenantId}:tenant:` : '_OVERRIDE_:';

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
    resolveConfigLayers,
    clearAppConfigCache,
    clearOverrideCache,
    reloadBaseConfig,
    overrideCacheTtl,
    rederiveEndpoints,
  };
}

export type AppConfigService = ReturnType<typeof createAppConfigService>;
