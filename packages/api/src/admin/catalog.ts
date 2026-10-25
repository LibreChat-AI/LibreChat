import { createHash } from 'node:crypto';
import { logger, isBaseConfigPrincipal, BASE_CONFIG_PRINCIPAL_ID } from '@librechat/data-schemas';
import {
  AuthType,
  PrincipalType,
  EModelEndpoint,
  isSensitiveEnvVar,
  extractEnvVariable,
  getEnabledEndpoints,
  normalizeEndpointName,
  isProcessMCPServerConfig,
} from 'librechat-data-provider';
import type {
  AppConfig,
  ConfigRecord,
  ConfigSection,
  AdminCatalogTool,
  AdminConfigEnvSource,
  AdminConfigEnvStatus,
  AdminCatalogModels,
  AdminCatalogEndpoint,
  AdminCatalogMcpServer,
  AdminCatalogEndpointReason,
  AdminConfigCatalogResponse,
  AdminConfigEnvStatusResponse,
} from '@librechat/data-schemas';
import type {
  TPlugin,
  TEndpoint,
  TModelsConfig,
  TCustomConfig,
  TEndpointsConfig,
} from 'librechat-data-provider';
import type { Response } from 'express';
import type { CapabilityUser } from '~/middleware/capabilities';
import type { GetAppConfigOptions } from '~/app/service';
import type { ManifestTool } from '~/tools/available';
import type { ServerRequest } from '~/types/http';
import {
  canReadSection,
  getCapabilityUser,
  validatePrincipalType,
  forbiddenResponse,
  authRequiredResponse,
  principalNotFoundResponse,
} from './config';
import {
  parseEnvAllowlist,
  collectEnvReferenceSections,
  collectDefaultEnvReferenceSections,
} from '~/app/allowlist';
import { resolveServedCustomEndpoints } from '~/endpoints/custom/config';
import { getConfigPartition, getActivePartition } from './partition';
import { listAvailableTools } from '~/tools/available';
import { getSafeErrorMetadata } from '~/utils/errors';
import { resolveConfigSecret } from './secrets';
import { getCatalogModelsTtlMs } from './meta';
import { isUserProvided } from '~/utils';

/**
 * Who a scope's endpoint, model and tool lists are resolved for: the scope, never a user. It has
 * no user id, so nothing reads a user's stored keys, and header templates that name a user
 * resolve to nothing instead of to the admin's identity.
 */
export interface CatalogScopeUser {
  tenantId?: string;
  role?: string;
}

/** The request-like argument the endpoint and model loaders read: a scope's config and user. */
export interface CatalogScopeRequest {
  config: AppConfig;
  user: CatalogScopeUser;
}

export interface AdminConfigCatalogDeps {
  hasAnyConfigReadAccess: (user: CapabilityUser) => Promise<boolean>;
  getReadableConfigSections: (
    user: CapabilityUser,
    sections: ConfigSection[],
  ) => Promise<{ broad: boolean; sections: Set<string> }>;
  hasConfigCapability: (
    user: CapabilityUser,
    section: ConfigSection | null,
    verb?: 'manage' | 'read',
  ) => Promise<boolean>;
  /** The resolved config, as the app config service serves it (secrets decrypted). */
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  /** What `GET /api/endpoints` serves for a request's config. */
  getEndpointsConfig: (req: CatalogScopeRequest) => Promise<TEndpointsConfig>;
  /** The built-in endpoints' models for a request's config (`loadDefaultModels`). */
  loadDefaultModels: (req: CatalogScopeRequest) => Promise<TModelsConfig>;
  /** The configured and custom endpoints' models for a request's config (`loadConfigModels`). */
  loadConfigModels: (req: CatalogScopeRequest) => Promise<TModelsConfig>;
  /** The tool definitions the server loaded (the tool cache). */
  getCachedTools?: () => Promise<Record<string, unknown> | null | undefined>;
  /** The tool manifest and its toolkits (`api/app/clients/tools`). */
  toolManifest?: ManifestTool[];
  toolkits?: TPlugin[];
  /** Whether the principal exists in the caller's tenant partition (`principalExists`). */
  principalExists?: (principalType: PrincipalType, principalId: string) => Promise<boolean>;
  /**
   * A principal's config document, active or not. A group or user scope resolves in the tenant
   * partition that stores its profile, as `GET /resolved` resolves it; without this lookup every
   * scope resolves in the caller's.
   */
  findConfigByPrincipal?: (
    principalType: PrincipalType,
    principalId: string,
    options?: { includeInactive?: boolean },
  ) => Promise<ConfigRecord | null>;
  /** Every config document of the caller's partition, for the env names profiles reference. */
  listAllConfigs?: () => Promise<ConfigRecord[]>;
  /** `CONFIG_OVERRIDE_ENV_ALLOWLIST`, as the app config service is given it. */
  overrideEnvAllowlist?: string;
}

/**
 * The env names that decide whether each built-in endpoint is served, and with which credentials
 * or base URL: every name `api/server/services/Config/EndpointService.js` and
 * `loadAsyncEndpoints.js` read (`ANTHROPIC_USE_VERTEX` serves Anthropic without a key). Every
 * name overrides may reference as an endpoint credential (`ENDPOINT_CREDENTIAL_ENV_NAMES`) is
 * here.
 */
export const BUILT_IN_ENDPOINT_ENV: Readonly<Record<string, readonly string[]>> = {
  [EModelEndpoint.openAI]: ['OPENAI_API_KEY', 'OPENAI_REVERSE_PROXY'],
  [EModelEndpoint.agents]: [],
  [EModelEndpoint.assistants]: ['ASSISTANTS_API_KEY', 'ASSISTANTS_BASE_URL'],
  [EModelEndpoint.azureAssistants]: ['AZURE_ASSISTANTS_API_KEY', 'AZURE_ASSISTANTS_BASE_URL'],
  [EModelEndpoint.azureOpenAI]: ['AZURE_API_KEY', 'AZURE_OPENAI_BASEURL'],
  [EModelEndpoint.google]: ['GOOGLE_KEY', 'GOOGLE_SERVICE_KEY_FILE'],
  [EModelEndpoint.anthropic]: ['ANTHROPIC_API_KEY', 'ANTHROPIC_USE_VERTEX'],
  [EModelEndpoint.bedrock]: [
    'BEDROCK_AWS_BEARER_TOKEN',
    'BEDROCK_AWS_ACCESS_KEY_ID',
    'BEDROCK_AWS_SECRET_ACCESS_KEY',
    'BEDROCK_AWS_SESSION_TOKEN',
    'BEDROCK_AWS_PROFILE',
    'BEDROCK_AWS_DEFAULT_REGION',
  ],
};

/** Built-in endpoints whose configured `models` list replaces the provider's list. */
const MODEL_LIST_ENDPOINTS: readonly string[] = [
  EModelEndpoint.openAI,
  EModelEndpoint.google,
  EModelEndpoint.anthropic,
  EModelEndpoint.bedrock,
];

/** Most scopes whose model lists are kept at once; the oldest is dropped first. */
const MAX_CACHED_SCOPES = 100;

const ENV_REFERENCE = /\$\{([^}]+)\}/g;

type CachedModels = { expires: number; models: Promise<Record<string, AdminCatalogModels>> };

function isSet(value: string | undefined): boolean {
  return value != null && value.trim() !== '';
}

function namesOf(models: unknown): string[] | undefined {
  if (!Array.isArray(models)) {
    return undefined;
  }
  return models.flatMap((model) => {
    if (typeof model === 'string') {
      return [model];
    }
    const name = (model as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? [name] : [];
  });
}

function referencedEnvNames(...values: unknown[]): string[] {
  const names = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string') {
      for (const match of value.matchAll(ENV_REFERENCE)) {
        names.add(match[1]);
      }
    }
  }
  return [...names];
}

/** Whether a custom endpoint fetches its models with a key and URL the server holds. */
function fetchesWithServerKey(endpoint: Partial<TEndpoint>): boolean {
  return (
    endpoint.models?.fetch === true &&
    !isUserProvided(resolveConfigSecret(endpoint.apiKey) ?? '') &&
    !isUserProvided(extractEnvVariable(endpoint.baseURL ?? ''))
  );
}

function getCustomEndpoints(config: AppConfig): TEndpoint[] {
  const custom = config.endpoints?.custom;
  return Array.isArray(custom) ? (custom as TEndpoint[]) : [];
}

/**
 * The definition the catalog reports for each custom endpoint name: the one the endpoint config
 * serves under that name (`resolveServedCustomEndpoints`), or the last definition of a name it
 * serves none of.
 */
function resolveCustomEndpoints(config: AppConfig): Map<string, Partial<TEndpoint>> {
  const custom = getCustomEndpoints(config);
  const served = resolveServedCustomEndpoints(custom);
  const resolved = new Map<string, Partial<TEndpoint>>();
  for (const endpoint of custom) {
    const name = normalizeEndpointName(endpoint.name ?? '');
    if (name !== '') {
      resolved.set(name, served.get(name) ?? endpoint);
    }
  }
  return resolved;
}

/** `config` without the model lists of built-in endpoints, so their defaults load instead. */
function withoutModelLists(config: AppConfig): AppConfig {
  const endpoints = config.endpoints;
  if (!endpoints) {
    return config;
  }
  const next: Record<string, unknown> = { ...endpoints };
  for (const name of MODEL_LIST_ENDPOINTS) {
    const entry = next[name] as { models?: unknown } | undefined;
    if (entry != null && Array.isArray(entry.models)) {
      const { models: _configured, ...rest } = entry;
      next[name] = rest;
    }
  }
  return { ...config, endpoints: next as AppConfig['endpoints'] };
}

/**
 * `config` with the configured list left out of each custom endpoint that fetches its models with
 * the server's key, so the loader reports what the fetch returns rather than the fallback.
 */
function withoutFetchFallbacks(config: AppConfig): AppConfig {
  const custom = getCustomEndpoints(config);
  if (!custom.some(fetchesWithServerKey)) {
    return config;
  }
  return {
    ...config,
    endpoints: {
      ...config.endpoints,
      custom: custom.map((endpoint) => {
        if (!fetchesWithServerKey(endpoint)) {
          return endpoint;
        }
        const { default: _fallback, ...models } = endpoint.models ?? {};
        return { ...endpoint, models: { ...models, fetch: true } };
      }),
    } as AppConfig['endpoints'],
  };
}

/** Why a custom endpoint the endpoint config leaves out is not served. */
function getCustomReason(endpoint: Partial<TEndpoint>): AdminCatalogEndpointReason {
  if (!endpoint.apiKey) {
    return 'missing_api_key';
  }
  if (!endpoint.baseURL) {
    return 'missing_base_url';
  }
  return 'missing_models';
}

function getMcpTransport(server: Record<string, unknown>): AdminCatalogMcpServer['transport'] {
  if (isProcessMCPServerConfig(server)) {
    return 'stdio';
  }
  switch (server.type) {
    case 'streamable-http':
    case 'http':
      return 'streamable-http';
    case 'websocket':
      return 'websocket';
    case 'sse':
      return 'sse';
    default:
      return typeof server.url === 'string' && /^wss?:\/\//i.test(server.url) ? 'websocket' : 'sse';
  }
}

/** The MCP servers a scope's config defines (librechat.yaml's and its profiles'), unhidden. */
function listMcpServers(config: AppConfig): AdminCatalogMcpServer[] {
  const servers = (config.mcpConfig ?? {}) as Record<string, unknown>;
  const yaml = (config.config?.mcpServers ?? {}) as Record<string, unknown>;
  return Object.entries(servers).flatMap(([name, value]) => {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      return [];
    }
    const server = value as Record<string, unknown>;
    return [
      {
        name,
        ...(typeof server.title === 'string' && { title: server.title }),
        transport: getMcpTransport(server),
        source: Object.prototype.hasOwnProperty.call(yaml, name) ? 'yaml' : 'override',
        processBacked: isProcessMCPServerConfig(server),
      },
    ];
  });
}

function toCatalogTool(tool: TPlugin): AdminCatalogTool {
  return {
    pluginKey: tool.pluginKey,
    name: tool.name,
    ...(tool.description != null && { description: tool.description }),
    ...(tool.icon != null && { icon: tool.icon }),
    ...(tool.authenticated === true && { authenticated: true }),
    ...(tool.toolkit === true && { toolkit: true }),
  };
}

/** The `getAppConfig` options that resolve a scope as its users get it, never from a cache. */
function toScopeOptions(
  principalType: PrincipalType,
  principalId: string,
  tenantId: string | undefined,
): GetAppConfigOptions {
  const options: GetAppConfigOptions = {
    tenantId,
    bypassOverrideCache: true,
    skipRuntimeAugmentation: true,
  };
  if (isBaseConfigPrincipal({ principalType, principalId })) {
    return options;
  }
  if (principalType === PrincipalType.ROLE) {
    return { ...options, role: principalId };
  }
  return { ...options, resolvedPrincipals: [{ principalType, principalId }] };
}

/**
 * The deployment views the admin panel builds its pickers and status badges from, resolved for a
 * scope instead of for the signed-in admin: `GET /catalog` (`catalogApi`) and `GET /env-status`
 * (`envStatus`). Neither runs the end-user routes' browser checks, so a server-side client can
 * call them without forwarding a User-Agent.
 */
export function createAdminConfigCatalogHandlers(deps: AdminConfigCatalogDeps): {
  getConfigCatalog: (req: ServerRequest, res: Response) => Promise<Response>;
  getEnvStatus: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    hasAnyConfigReadAccess,
    getReadableConfigSections,
    hasConfigCapability,
    getAppConfig,
    getEndpointsConfig,
    loadDefaultModels,
    loadConfigModels,
    getCachedTools,
    toolManifest = [],
    toolkits = [],
    principalExists,
    findConfigByPrincipal,
    listAllConfigs,
    overrideEnvAllowlist,
  } = deps;

  const envAllowlist = parseEnvAllowlist(overrideEnvAllowlist);
  const modelsCache = new Map<string, CachedModels>();

  function buildEndpoints(
    config: AppConfig,
    served: TEndpointsConfig,
  ): Record<string, AdminCatalogEndpoint> {
    const listed = new Set(getEnabledEndpoints());
    const listsEndpoints = isSet(process.env.ENDPOINTS);
    const endpoints: Record<string, AdminCatalogEndpoint> = {};
    for (const [name, envVars] of Object.entries(BUILT_IN_ENDPOINT_ENV)) {
      const entry = served?.[name];
      endpoints[name] = {
        enabled: entry != null,
        custom: false,
        envVars: [...envVars],
        ...(entry != null
          ? { config: entry }
          : { reason: listsEndpoints && !listed.has(name) ? 'not_listed' : 'missing_credentials' }),
      };
    }
    for (const [name, endpoint] of resolveCustomEndpoints(config)) {
      const entry = served?.[name];
      endpoints[name] = {
        enabled: entry != null,
        custom: true,
        envVars: referencedEnvNames(endpoint.apiKey, endpoint.baseURL),
        ...(entry != null ? { config: entry } : { reason: getCustomReason(endpoint) }),
      };
    }
    return endpoints;
  }

  async function loadModels(
    request: CatalogScopeRequest,
  ): Promise<Record<string, AdminCatalogModels>> {
    const [defaults, configured] = await Promise.all([
      loadDefaultModels({ ...request, config: withoutModelLists(request.config) }),
      loadConfigModels({ ...request, config: withoutFetchFallbacks(request.config) }),
    ]);
    const custom = resolveCustomEndpoints(request.config);
    const models: Record<string, AdminCatalogModels> = {};
    for (const name of new Set([
      ...Object.keys(defaults ?? {}),
      ...Object.keys(configured ?? {}),
    ])) {
      const endpoint = custom.get(name);
      const loaded = configured?.[name];
      if (endpoint == null) {
        const fallback = defaults?.[name] ?? [];
        models[name] = {
          served: loaded ?? fallback,
          ...(loaded && { configured: loaded }),
          defaults: fallback,
        };
        continue;
      }
      const list = namesOf(endpoint.models?.default);
      if (!fetchesWithServerKey(endpoint)) {
        models[name] = { served: loaded ?? list ?? [], ...(list && { configured: list }) };
        continue;
      }
      const fetched = loaded ?? [];
      models[name] = {
        served: fetched.length > 0 ? fetched : (list ?? []),
        ...(list && { configured: list }),
        defaults: fetched,
      };
    }
    return models;
  }

  /**
   * A scope's model lists, reused for the lifetime librechat.yaml gives them
   * (`getCatalogModelsTtlMs`, none at `0`) while its endpoint config (and so every provider
   * request) is the same: a save that changes an endpoint resolves anew, and reads of one scope in
   * a row share one round of provider requests. Only a hash of the config is kept.
   */
  function getModels(
    request: CatalogScopeRequest,
    scope: string,
  ): Promise<Record<string, AdminCatalogModels>> {
    const ttlMs = getCatalogModelsTtlMs(request.config);
    if (ttlMs === 0) {
      return loadModels(request);
    }
    const key = createHash('sha256')
      .update(JSON.stringify([scope, request.user, request.config.endpoints ?? null]))
      .digest('hex');
    const now = Date.now();
    const cached = modelsCache.get(key);
    if (cached && cached.expires > now) {
      return cached.models;
    }
    modelsCache.delete(key);
    if (modelsCache.size >= MAX_CACHED_SCOPES) {
      const oldest = modelsCache.keys().next().value;
      if (oldest !== undefined) {
        modelsCache.delete(oldest);
      }
    }
    const models = loadModels(request);
    modelsCache.set(key, { expires: now + ttlMs, models });
    models.catch(() => {
      if (modelsCache.get(key)?.models === models) {
        modelsCache.delete(key);
      }
    });
    return models;
  }

  async function listTools(config: AppConfig): Promise<AdminCatalogTool[]> {
    const toolDefinitions = (await getCachedTools?.()) ?? config.availableTools;
    return listAvailableTools({
      manifest: toolManifest,
      toolkits,
      toolDefinitions,
      githubCompare: config.githubCompare,
    }).map(toCatalogTool);
  }

  /**
   * Whether a scope can be resolved, and the tenant partition it resolves in: the caller's, or for
   * a group or user profile a caller without a tenant reads from a tenant, the tenant that stores
   * it. A scope without a profile must exist in the caller's partition.
   */
  async function locateScope(
    principalType: PrincipalType,
    principalId: string,
    isBase: boolean,
  ): Promise<{ exists: boolean; tenantId: string | undefined }> {
    const activePartition = getActivePartition();
    if (isBase) {
      return { exists: true, tenantId: activePartition };
    }
    const [stored, exists] = await Promise.all([
      principalType !== PrincipalType.ROLE && findConfigByPrincipal
        ? findConfigByPrincipal(principalType, principalId, { includeInactive: true })
        : null,
      principalExists ? principalExists(principalType, principalId) : true,
    ]);
    if (stored) {
      return { exists: true, tenantId: getConfigPartition(stored) };
    }
    return { exists, tenantId: activePartition };
  }

  /**
   * GET /catalog?principalType=&principalId= — the endpoints, models, MCP servers and tools a
   * scope serves (Base when no principal is named), resolved as `getAppConfig` resolves it for
   * that scope from the stored documents, never the override cache, in the partition the scope's
   * profile merges in (`locateScope`). Model lists are never loaded with a user's stored key. A
   * part is left out unless the caller can read its section.
   */
  async function getConfigCatalog(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const query = req.query as Record<string, unknown>;
      const principalType = query.principalType ?? PrincipalType.ROLE;
      const principalId = query.principalId ?? BASE_CONFIG_PRINCIPAL_ID;
      if (
        typeof principalType !== 'string' ||
        typeof principalId !== 'string' ||
        principalId === '' ||
        (query.principalType == null) !== (query.principalId == null) ||
        !validatePrincipalType(principalType)
      ) {
        return res.status(400).json({ error: 'Invalid principal', code: 'INVALID_PRINCIPAL' });
      }
      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }
      if (!(await hasAnyConfigReadAccess(user))) {
        return forbiddenResponse(res);
      }
      const isBase = isBaseConfigPrincipal({ principalType, principalId });
      const [readable, scope] = await Promise.all([
        getReadableConfigSections(user, [
          'endpoints',
          'mcpServers',
          'filteredTools',
          'includedTools',
        ]),
        locateScope(principalType, principalId, isBase),
      ]);
      if (!scope.exists) {
        return principalNotFoundResponse(res);
      }

      const config = await getAppConfig(toScopeOptions(principalType, principalId, scope.tenantId));
      const request: CatalogScopeRequest = {
        config,
        user: {
          tenantId: scope.tenantId,
          ...(principalType === PrincipalType.ROLE && !isBase && { role: principalId }),
        },
      };
      const readsEndpoints = canReadSection(readable, 'endpoints');
      const readsTools =
        canReadSection(readable, 'filteredTools') || canReadSection(readable, 'includedTools');
      const [served, models, tools] = await Promise.all([
        readsEndpoints ? getEndpointsConfig(request) : undefined,
        readsEndpoints ? getModels(request, `${principalType}:${principalId}`) : undefined,
        readsTools ? listTools(config) : undefined,
      ]);
      const body: AdminConfigCatalogResponse = {
        principalType,
        principalId,
        ...(served !== undefined && { endpoints: buildEndpoints(config, served) }),
        ...(models !== undefined && { models }),
        ...(tools !== undefined && { tools }),
        ...(canReadSection(readable, 'mcpServers') && { mcpServers: listMcpServers(config) }),
      };
      return res.status(200).json(body);
    } catch (error) {
      logger.error('[adminConfig] getConfigCatalog error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to load config catalog' });
    }
  }

  /** The env names stored profiles reference, by section; read only for broad managers. */
  async function getOverrideReferences(user: CapabilityUser): Promise<Map<string, Set<string>>> {
    if (
      !listAllConfigs ||
      process.env.TENANT_ISOLATION_STRICT === 'true' ||
      !(await hasConfigCapability(user, null, 'manage'))
    ) {
      return new Map();
    }
    const references = new Map<string, Set<string>>();
    for (const config of await listAllConfigs()) {
      for (const [name, sections] of collectEnvReferenceSections(config.overrides ?? {})) {
        const held = references.get(name) ?? new Set<string>();
        sections.forEach((section) => held.add(section));
        references.set(name, held);
      }
    }
    return references;
  }

  /**
   * GET /env-status — whether each env name the deployment's config uses is set on this server,
   * never its value: the names librechat.yaml references, the defaults it fills in (web search,
   * OCR), the built-in endpoints' credentials, `CONFIG_OVERRIDE_ENV_ALLOWLIST`, and, for broad
   * `manage:configs` holders outside strict tenant isolation, the names stored profiles
   * reference. A name used only in sections the caller cannot read is left out, as are the names
   * the allowlist and profiles add for a caller without broad read access, and infrastructure
   * secrets (`CREDS_KEY`, ...) whatever references them.
   */
  async function getEnvStatus(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }
      if (!(await hasAnyConfigReadAccess(user))) {
        return forbiddenResponse(res);
      }
      const [baseConfig, overrides] = await Promise.all([
        getAppConfig({ tenantId: user.tenantId, baseOnly: true }),
        getOverrideReferences(user),
      ]);
      const yaml: Partial<TCustomConfig> = baseConfig.config ?? {};
      const uses = new Map<string, { sources: Set<AdminConfigEnvSource>; sections: Set<string> }>();
      const add = (name: string, source: AdminConfigEnvSource, sections: Iterable<string>) => {
        if (isSensitiveEnvVar(name)) {
          return;
        }
        const use = uses.get(name) ?? { sources: new Set(), sections: new Set() };
        use.sources.add(source);
        for (const section of sections) {
          use.sections.add(section);
        }
        uses.set(name, use);
      };
      for (const [name, sections] of collectEnvReferenceSections(yaml)) {
        add(name, 'yaml', sections);
      }
      for (const [name, sections] of collectDefaultEnvReferenceSections(yaml)) {
        add(name, 'default', sections);
      }
      for (const name of Object.values(BUILT_IN_ENDPOINT_ENV).flat()) {
        add(name, 'endpoint', ['endpoints']);
      }
      for (const name of envAllowlist) {
        add(name, 'allowlist', []);
      }
      for (const [name, sections] of overrides) {
        add(name, 'override', sections);
      }

      const sections = new Set([...uses.values()].flatMap(({ sections: held }) => [...held]));
      const readable = await getReadableConfigSections(user, [...sections] as ConfigSection[]);
      const vars: Record<string, AdminConfigEnvStatus> = {};
      for (const [name, use] of [...uses].sort(([a], [b]) => a.localeCompare(b))) {
        const visible =
          readable.broad || [...use.sections].some((section) => canReadSection(readable, section));
        if (!visible) {
          continue;
        }
        const value = process.env[name];
        vars[name] = {
          set: isSet(value),
          ...(value?.trim() === AuthType.USER_PROVIDED && { userProvided: true }),
          sources: [...use.sources],
        };
      }
      const body: AdminConfigEnvStatusResponse = { vars };
      return res.status(200).json(body);
    } catch (error) {
      logger.error('[adminConfig] getEnvStatus error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to read env status' });
    }
  }

  return { getConfigCatalog, getEnvStatus };
}
