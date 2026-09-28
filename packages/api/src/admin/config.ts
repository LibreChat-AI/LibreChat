import { logger, BASE_CONFIG_PRINCIPAL_ID } from '@librechat/data-schemas';
import {
  BASE_PRINCIPAL_CONFIG_SECTIONS,
  BASE_ONLY_CONFIG_SECTIONS,
  PrincipalType,
  PrincipalModel,
  INTERFACE_PERMISSION_FIELDS,
  RUNTIME_CONFIG_INTERFACE_FIELDS,
  PERMISSION_SUB_KEYS,
  hasProcessMCPServerConfig,
  isProcessMCPServerConfig,
  isProcessMCPServerField,
  getConfigOverrideIssues,
} from 'librechat-data-provider';
import type { AppConfig, ConfigSection, IConfig, SystemCapability } from '@librechat/data-schemas';
import type { ConfigOverrideIssue, TCustomConfig } from 'librechat-data-provider';
import type { Types, ClientSession } from 'mongoose';
import type { Response } from 'express';
import type { CapabilityUser } from '~/middleware/capabilities';
import type { ServerRequest } from '~/types/http';
import {
  encryptConfigSecretFields,
  encryptConfigSecrets,
  getConfigSecretMutationPaths,
  getConfigSecretInputError,
  getConfigSecretSections,
  isConfigSecretAncestorPath,
  isConfigSecretDescendantPath,
  isConfigSecretPreservablePatch,
  preserveConfigSecrets,
  redactConfigSecrets,
} from './secrets';

const UNSAFE_SEGMENTS = /(?:^|\.)(__[\w]*|constructor|prototype)(?:\.|$)/;
const MAX_PATCH_ENTRIES = 100;
const DEFAULT_PRIORITY = 10;
const BASE_ONLY_OVERRIDE_SECTIONS = new Set<string>(BASE_ONLY_CONFIG_SECTIONS);
const BASE_PRINCIPAL_OVERRIDE_SECTIONS = new Set<string>(BASE_PRINCIPAL_CONFIG_SECTIONS);
const PROCESS_MCP_CONFIG_ERROR =
  'Process-backed MCP servers can only be configured in librechat.yaml';
const LANGFUSE_HEADERS_CONFIG_ERROR =
  'Langfuse request headers can only be configured in librechat.yaml';

/**
 * Langfuse export headers carry proxy/gateway credentials, but they are a map
 * of values rather than one scalar path, so the config secret registry cannot
 * encrypt them at rest or mask them on read. Keeping them out of stored
 * overrides is what makes them deployment-level: an admin-written map would sit
 * in Mongo in plaintext and come back in plaintext, unlike `langfuse.secretKey`.
 */
function isLangfuseHeadersFieldPath(fieldPath: string): boolean {
  return fieldPath === 'langfuse.headers' || fieldPath.startsWith('langfuse.headers.');
}

/**
 * Whether an overrides payload carries Langfuse headers under any spelling.
 *
 * `overrides` is a Mixed document written wholesale, so a dotted property name
 * survives verbatim: `{ langfuse: { "headers.X-Token": "..." } }` and
 * `{ "langfuse.headers": {...} }` both persist a credential that the nested-map
 * redactor never walks, and a later read returns it unchanged.
 */
function hasLangfuseHeadersOverride(rawOverrides: Record<string, unknown>): boolean {
  for (const key of Object.keys(rawOverrides)) {
    if (key === 'langfuse.headers' || key.startsWith('langfuse.headers.')) {
      return true;
    }
  }

  const rawLangfuse = rawOverrides.langfuse;
  if (rawLangfuse == null || typeof rawLangfuse !== 'object' || Array.isArray(rawLangfuse)) {
    return false;
  }
  return Object.keys(rawLangfuse).some((key) => key === 'headers' || key.startsWith('headers.'));
}

export function isValidFieldPath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.startsWith('.') &&
    !path.endsWith('.') &&
    !path.includes('..') &&
    !path.includes('$') &&
    !UNSAFE_SEGMENTS.test(path)
  );
}

export function getTopLevelSection(fieldPath: string): string {
  return fieldPath.split('.')[0];
}

function isBaseOnlyFieldPath(fieldPath: string): boolean {
  return BASE_ONLY_OVERRIDE_SECTIONS.has(getTopLevelSection(fieldPath));
}

function isProcessMCPServerFieldPath(fieldPath: string, value: unknown): boolean {
  const [section, _serverName, field] = fieldPath.split('.');
  if (section !== 'mcpServers' && section !== 'mcpConfig') {
    return false;
  }
  if (field == null) {
    return fieldPath === section
      ? hasProcessMCPServerConfig(value)
      : isProcessMCPServerConfig(value);
  }
  return isProcessMCPServerField(field) || (field === 'type' && value === 'stdio');
}

/**
 * Returns true if `fieldPath` targets an interface permission field or permission sub-key.
 *
 * - `"interface.prompts"` → true (boolean permission field)
 * - `"interface.agents.use"` → true (permission sub-key)
 * - `"interface.mcpServers"` → true (entire composite field)
 * - `"interface.mcpServers.use"` → true (permission sub-key)
 * - `"interface.mcpServers.placeholder"` → false (UI-only sub-key)
 * - `"interface.peoplePicker.users"` → true (all peoplePicker sub-keys are permissions)
 * - `"interface.modelSelect"` → false (UI-only field)
 */
function isInterfacePermissionPath(fieldPath: string): boolean {
  const parts = fieldPath.split('.');
  if (parts[0] !== 'interface' || parts.length < 2) {
    return false;
  }
  if (!INTERFACE_PERMISSION_FIELDS.has(parts[1])) {
    return false;
  }
  // "interface.<permField>" with no sub-key → permission (blocks the whole field),
  // EXCEPT dual-purpose runtime fields (e.g. schedules) whose bare top-level value
  // is a runtime enable toggle, not a permission — those must pass through so admin
  // field patches/tombstones can set or clear them (their .use/.create permission
  // sub-keys are still blocked below).
  if (parts.length === 2) {
    return !RUNTIME_CONFIG_INTERFACE_FIELDS.has(parts[1]);
  }
  // "interface.<permField>.<subKey>" → only block if sub-key is a permission bit
  return PERMISSION_SUB_KEYS.has(parts[2]);
}

/**
 * Collapses an explicit disable on a dual-purpose runtime interface field (e.g. `schedules`)
 * to its boolean form.
 *
 * For these fields `use` is BOTH a permission bit — stripped from DB overrides — and the
 * runtime disable signal. Stripping it alone would leave `{ maxPerUser: 2 }`, which
 * `getLimits` reads as ENABLED because an object opts in unless it sets `use: false`. An
 * override written to stop scheduled billing for a principal would therefore start it.
 * Other object forms are left alone so a principal can still narrow limits.
 */
function normalizeRuntimeInterfaceValue(field: string, value: unknown): unknown {
  if (!RUNTIME_CONFIG_INTERFACE_FIELDS.has(field)) {
    return value;
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  return (value as Record<string, unknown>).use === false ? false : value;
}

/** Applies {@link normalizeRuntimeInterfaceValue} to a bare `interface.<field>` patch. */
function normalizeInterfaceFieldPatch(fieldPath: string, value: unknown): unknown {
  const parts = fieldPath.split('.');
  if (parts[0] !== 'interface' || parts.length !== 2) {
    return value;
  }
  return normalizeRuntimeInterfaceValue(parts[1], value);
}

export interface AdminConfigDeps {
  listAllConfigs: (filter?: { isActive?: boolean }, session?: ClientSession) => Promise<IConfig[]>;
  findConfigByPrincipal: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    options?: { includeInactive?: boolean },
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  upsertConfig: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    overrides: Partial<TCustomConfig>,
    priority: number,
    session?: ClientSession,
    options?: { expectEmpty?: boolean; preservePriority?: boolean },
  ) => Promise<IConfig | null>;
  patchConfigFields: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    fields: Record<string, unknown>,
    priority: number,
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  tombstoneConfigField: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    fieldPath: string,
    priority: number,
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  unsetConfigField: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    fieldPath: string,
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  deleteConfig: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    session?: ClientSession,
    options?: { expectEmpty?: boolean },
  ) => Promise<IConfig | null>;
  toggleConfigActive: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    isActive: boolean,
    session?: ClientSession,
    options?: { expectEmpty?: boolean },
  ) => Promise<IConfig | null>;
  hasConfigCapability: (
    user: CapabilityUser,
    section: ConfigSection | null,
    verb?: 'manage' | 'read',
  ) => Promise<boolean>;
  /** Pre-flight-only: whether the caller holds any config-read capability at all (broad or any section), so a zero-access caller 403s before a DB fetch. */
  hasAnyConfigReadAccess?: (user: CapabilityUser) => Promise<boolean>;
  /** Resolves which of a set of sections the caller can read in a single batched query. */
  getReadableConfigSections?: (
    user: CapabilityUser,
    sections: ConfigSection[],
  ) => Promise<{ broad: boolean; sections: Set<string> }>;
  hasCapability?: (user: CapabilityUser, capability: SystemCapability) => Promise<boolean>;
  getAppConfig?: (options?: {
    role?: string;
    userId?: string;
    tenantId?: string;
    baseOnly?: boolean;
  }) => Promise<AppConfig>;
  /** Invalidate all config-related caches after a mutation. */
  invalidateConfigCaches?: (tenantId?: string) => Promise<void>;
}

// ── Validation helpers ───────────────────────────────────────────────

const CONFIG_PRINCIPAL_TYPES = new Set([
  PrincipalType.USER,
  PrincipalType.GROUP,
  PrincipalType.ROLE,
]);

function validatePrincipalType(value: string): value is PrincipalType {
  return CONFIG_PRINCIPAL_TYPES.has(value as PrincipalType);
}

function principalModel(type: PrincipalType): PrincipalModel {
  switch (type) {
    case PrincipalType.USER:
      return PrincipalModel.USER;
    case PrincipalType.GROUP:
      return PrincipalModel.GROUP;
    case PrincipalType.ROLE:
      return PrincipalModel.ROLE;
    case PrincipalType.PUBLIC:
      return PrincipalModel.ROLE;
    default: {
      const _exhaustive: never = type;
      logger.warn(`[adminConfig] Unmapped PrincipalType: ${String(_exhaustive)}`);
      return PrincipalModel.ROLE;
    }
  }
}

function getCapabilityUser(req: ServerRequest): CapabilityUser | null {
  if (!req.user) {
    return null;
  }
  return {
    id: req.user.id ?? req.user._id?.toString() ?? '',
    role: req.user.role ?? '',
    tenantId: (req.user as { tenantId?: string }).tenantId,
  };
}

/**
 * `AppConfig` keys exempt from the generic per-key `read:configs:<section>`
 * lookup in `filterSectionsByReadAccess`, for three distinct reasons:
 * - `paths` is a server-computed constant (resolved at module load), not a
 *   `TCustomConfig` section, so no `read:configs:<section>` grant could ever
 *   apply to it.
 * - `config` is the nested container whose contents are filtered separately
 *   below; checking the outer key against a nonexistent `read:configs:config`
 *   grant would always fail and strip the whole object, including sections
 *   the caller legitimately holds.
 * - `availableTools` is derived from the `filteredTools`/`includedTools`
 *   sections plus a filesystem scan, not itself a grantable section. It gets
 *   its own explicit check below, gated on those two source sections, rather
 *   than a lookup against the nonexistent `read:configs:availableTools`.
 * Real `TCustomConfig` sections (e.g. `fileStrategy`) must never be added
 * here: exempting one would return it to every caller regardless of grants.
 */
const STRUCTURAL_APP_CONFIG_KEYS = new Set(['paths', 'availableTools', 'config']);

/**
 * Top-level `AppConfig` response field → canonical `ConfigSection` name.
 * `getAppConfig` renames a few sections in the resolved payload
 * (`interface` → `interfaceConfig`, `turnstile` → `turnstileConfig`,
 * `mcpServers` → `mcpConfig`). The read-grant capability is keyed by the
 * canonical section name, so the top-level filter must normalize through
 * this map before calling `canRead`. Otherwise a caller holding
 * `read:configs:interface` gets `interfaceConfig` incorrectly stripped
 * because no section named "interfaceConfig" exists to grant.
 */
const APP_CONFIG_FIELD_TO_SECTION: Readonly<Record<string, string>> = {
  interfaceConfig: 'interface',
  turnstileConfig: 'turnstile',
  mcpConfig: 'mcpServers',
};

type ReadableSections = { broad: boolean; sections: ReadonlySet<string> };

function canReadSection(readable: ReadableSections, section: string): boolean {
  return readable.broad || readable.sections.has(section);
}

/** Strips every top-level key not in `preserveKeys` that `canRead` rejects. */
function filterSectionsByReadAccess<T extends Record<string, unknown>>(
  obj: T,
  canRead: (section: string) => boolean,
  preserveKeys: Set<string> = new Set(),
): T {
  const result: Record<string, unknown> = { ...obj };
  for (const key of Object.keys(result)) {
    if (!preserveKeys.has(key) && !canRead(key)) {
      delete result[key];
    }
  }
  return result as T;
}

function filterConfigDocForReadAccess(config: IConfig, readable: ReadableSections): IConfig {
  const canRead = (section: string): boolean => canReadSection(readable, section);
  const filteredOverrides = filterSectionsByReadAccess(
    (config.overrides ?? {}) as Record<string, unknown>,
    canRead,
  );

  let filteredTombstones = config.tombstones;
  if (config.tombstones?.length) {
    filteredTombstones = config.tombstones.filter((path) => canRead(getTopLevelSection(path)));
  }

  return {
    ...config,
    overrides: filteredOverrides as Partial<TCustomConfig>,
    tombstones: filteredTombstones,
  } as IConfig;
}

function filterAppConfigForReadAccess(appConfig: AppConfig, readable: ReadableSections): AppConfig {
  const canRead = (section: string): boolean => canReadSection(readable, section);
  const canReadTopLevelField = (field: string): boolean =>
    canRead(APP_CONFIG_FIELD_TO_SECTION[field] ?? field);

  const filtered = filterSectionsByReadAccess(
    appConfig as unknown as Record<string, unknown>,
    canReadTopLevelField,
    STRUCTURAL_APP_CONFIG_KEYS,
  );
  if (!canRead('filteredTools') && !canRead('includedTools')) {
    delete (filtered as { availableTools?: unknown }).availableTools;
  }
  const nestedConfig = (filtered as { config?: Record<string, unknown> }).config;
  if (nestedConfig != null && typeof nestedConfig === 'object') {
    (filtered as { config?: unknown }).config = filterSectionsByReadAccess(nestedConfig, canRead);
  }
  return filtered as unknown as AppConfig;
}

/** All section names an `IConfig` document's overrides/tombstones could reference. */
function collectConfigSections(config: IConfig): string[] {
  return [
    ...Object.keys(config.overrides ?? {}),
    ...(config.tombstones ?? []).map(getTopLevelSection),
  ];
}

/** All section names an `AppConfig` response could reference, normalized to canonical section names. */
function collectAppConfigSections(appConfig: AppConfig): string[] {
  const topLevel = Object.keys(appConfig)
    .filter((key) => !STRUCTURAL_APP_CONFIG_KEYS.has(key))
    .map((key) => APP_CONFIG_FIELD_TO_SECTION[key] ?? key);
  const nested = (appConfig as unknown as { config?: Record<string, unknown> }).config;
  return [...topLevel, ...(nested ? Object.keys(nested) : [])];
}

function redactConfigForResponse(config: IConfig): IConfig {
  const safeConfig = JSON.parse(JSON.stringify(config)) as IConfig;
  if (safeConfig.overrides) {
    redactConfigSecrets(safeConfig.overrides);
  }
  return safeConfig;
}

function redactAppConfigForResponse(appConfig: AppConfig): AppConfig {
  const safeConfig = JSON.parse(JSON.stringify(appConfig)) as AppConfig & { config?: unknown };
  redactConfigSecrets(safeConfig);
  if (safeConfig.config != null && typeof safeConfig.config === 'object') {
    redactConfigSecrets(safeConfig.config);
  }
  return safeConfig;
}

function invalidOverrideResponse(res: Response, issues: ConfigOverrideIssue[]): Response {
  const [first] = issues;
  return res.status(400).json({
    error: `Invalid config value at ${first.path}: ${first.message}`,
    issues,
  });
}

function preservePatchedConfigSecretFields(
  fields: Record<string, unknown>,
  existingOverrides?: unknown,
): Record<string, unknown> {
  const result = { ...fields };
  for (const [fieldPath, value] of Object.entries(result)) {
    if (isConfigSecretPreservablePatch(fieldPath, value)) {
      result[fieldPath] = preserveConfigSecrets(value, existingOverrides, fieldPath);
    }
  }
  return result;
}

// ── Handler factory ──────────────────────────────────────────────────

export function createAdminConfigHandlers(deps: AdminConfigDeps): {
  listConfigs: (req: ServerRequest, res: Response) => Promise<Response>;
  getBaseConfig: (req: ServerRequest, res: Response) => Promise<Response>;
  getConfig: (req: ServerRequest, res: Response) => Promise<Response>;
  upsertConfigOverrides: (req: ServerRequest, res: Response) => Promise<Response>;
  patchConfigField: (req: ServerRequest, res: Response) => Promise<Response>;
  tombstoneConfigField: (req: ServerRequest, res: Response) => Promise<Response>;
  deleteConfigField: (req: ServerRequest, res: Response) => Promise<Response>;
  deleteConfigOverrides: (req: ServerRequest, res: Response) => Promise<Response>;
  toggleConfig: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    listAllConfigs,
    findConfigByPrincipal,
    upsertConfig,
    patchConfigFields,
    tombstoneConfigField: writeConfigTombstone,
    unsetConfigField,
    deleteConfig,
    toggleConfigActive,
    hasConfigCapability,
    hasAnyConfigReadAccess = async () => false,
    getReadableConfigSections = async (u, sections) => {
      if (await hasConfigCapability(u, null, 'read')) {
        return { broad: true, sections: new Set(sections) };
      }
      const held = await Promise.all(
        sections.map((section) => hasConfigCapability(u, section, 'read')),
      );
      return { broad: false, sections: new Set(sections.filter((_, i) => held[i])) };
    },
    hasCapability = async () => false,
    getAppConfig,
    invalidateConfigCaches,
  } = deps;

  /**
   * GET / — List all active config overrides.
   */
  async function listConfigs(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!(await hasAnyConfigReadAccess(user))) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const configs = await listAllConfigs();
      const sections = [...new Set(configs.flatMap(collectConfigSections))] as ConfigSection[];
      const readable = await getReadableConfigSections(user, sections);
      const filtered = configs.map((config) => filterConfigDocForReadAccess(config, readable));

      const safeConfigs = filtered.map(redactConfigForResponse);
      return res.status(200).json({ configs: safeConfigs });
    } catch (error) {
      logger.error('[adminConfig] listConfigs error:', error);
      return res.status(500).json({ error: 'Failed to list configs' });
    }
  }

  /**
   * GET /base — Return the raw AppConfig (YAML + DB base merged).
   * This is the full config structure admins can edit, NOT the startup payload.
   */
  async function getBaseConfig(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!getAppConfig) {
        return res.status(501).json({ error: 'Base config endpoint not configured' });
      }

      if (!(await hasAnyConfigReadAccess(user))) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const baseOnly = (req.query as Record<string, unknown>).baseOnly === 'true';
      const appConfig = await getAppConfig({
        tenantId: user.tenantId,
        baseOnly,
      });
      const sections = collectAppConfigSections(appConfig) as ConfigSection[];
      const readable = await getReadableConfigSections(user, sections);
      const filteredAppConfig = filterAppConfigForReadAccess(appConfig, readable);

      return res.status(200).json({ config: redactAppConfigForResponse(filteredAppConfig) });
    } catch (error) {
      logger.error('[adminConfig] getBaseConfig error:', error);
      return res.status(500).json({ error: 'Failed to get base config' });
    }
  }

  /**
   * GET /:principalType/:principalId — Get config for a specific principal.
   */
  async function getConfig(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return res.status(400).json({ error: `Invalid principalType: ${principalType}` });
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!(await hasAnyConfigReadAccess(user))) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const config = await findConfigByPrincipal(principalType, principalId, {
        includeInactive: true,
      });
      if (!config) {
        return res.status(404).json({ error: 'Config not found' });
      }

      const sections = collectConfigSections(config) as ConfigSection[];
      const readable = await getReadableConfigSections(user, sections);
      const filteredConfig = filterConfigDocForReadAccess(config, readable);

      return res.status(200).json({ config: redactConfigForResponse(filteredConfig) });
    } catch (error) {
      logger.error('[adminConfig] getConfig error:', error);
      return res.status(500).json({ error: 'Failed to get config' });
    }
  }

  /**
   * PUT /:principalType/:principalId — Replace entire overrides for a principal.
   */
  async function upsertConfigOverrides(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return res.status(400).json({ error: `Invalid principalType: ${principalType}` });
      }

      const { overrides, priority } = req.body as {
        overrides?: Partial<TCustomConfig>;
        priority?: number;
      };

      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        return res.status(400).json({ error: 'overrides must be a plain object' });
      }

      const rawOverrides = overrides as Record<string, unknown>;
      if (
        hasProcessMCPServerConfig(rawOverrides.mcpServers) ||
        hasProcessMCPServerConfig(rawOverrides.mcpConfig)
      ) {
        return res.status(400).json({ error: PROCESS_MCP_CONFIG_ERROR });
      }

      if (hasLangfuseHeadersOverride(rawOverrides)) {
        return res.status(400).json({ error: LANGFUSE_HEADERS_CONFIG_ERROR });
      }

      if (priority != null && (typeof priority !== 'number' || priority < 0)) {
        return res.status(400).json({ error: 'priority must be a non-negative number' });
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const hasAssignConfigs =
        hasBroadManage ||
        (await hasCapability(user, `assign:configs:${principalType}` as SystemCapability));

      if (!hasAssignConfigs) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const filteredOverrides = {
        ...(overrides as Record<string, unknown>),
      } as Partial<TCustomConfig>;
      for (const section of BASE_ONLY_OVERRIDE_SECTIONS) {
        if (section in filteredOverrides) {
          delete (filteredOverrides as Record<string, unknown>)[section];
          logger.warn(
            `[adminConfig] Stripping base-only config section "${section}" - configure it in librechat.yaml instead`,
          );
        }
      }
      for (const key of Object.keys(filteredOverrides)) {
        const section = getTopLevelSection(key);
        if (BASE_PRINCIPAL_OVERRIDE_SECTIONS.has(section)) {
          delete (filteredOverrides as Record<string, unknown>)[key];
          logger.warn(
            `[adminConfig] Stripping dedicated tenant-wide config section "${key}" from the generic config API`,
          );
        }
      }
      const iface = (overrides as Record<string, unknown>).interface;
      if (iface != null && typeof iface === 'object' && !Array.isArray(iface)) {
        const filteredIface: Record<string, unknown> = {};
        for (const [field, rawVal] of Object.entries(iface as Record<string, unknown>)) {
          const val = normalizeRuntimeInterfaceValue(field, rawVal);
          if (!INTERFACE_PERMISSION_FIELDS.has(field)) {
            filteredIface[field] = val;
          } else if (val != null && typeof val === 'object' && !Array.isArray(val)) {
            // Composite permission field (e.g. mcpServers): strip permission
            // sub-keys but preserve UI-only sub-keys like placeholder/trustCheckbox.
            const uiOnly: Record<string, unknown> = {};
            for (const [sub, subVal] of Object.entries(val as Record<string, unknown>)) {
              if (!PERMISSION_SUB_KEYS.has(sub)) {
                uiOnly[sub] = subVal;
              } else {
                logger.warn(
                  `[adminConfig] Stripping interface permission sub-field "${field}.${sub}" — use role permissions instead`,
                );
              }
            }
            if (Object.keys(uiOnly).length > 0) {
              filteredIface[field] = uiOnly;
            }
          } else if (RUNTIME_CONFIG_INTERFACE_FIELDS.has(field)) {
            // Dual-purpose field: the boolean form is a runtime disable, not a
            // permission toggle, so preserve it (e.g. schedules: false).
            filteredIface[field] = val;
          } else {
            logger.warn(
              `[adminConfig] Stripping interface permission field "${field}" — use role permissions instead`,
            );
          }
        }
        if (Object.keys(filteredIface).length > 0) {
          (filteredOverrides as Record<string, unknown>).interface = filteredIface;
        } else {
          delete (filteredOverrides as Record<string, unknown>).interface;
        }
      }

      const overrideSections = Object.keys(filteredOverrides);

      if (overrideSections.length === 0 && priority == null) {
        return res.status(200).json({ message: 'No actionable override sections provided' });
      }

      if (overrideSections.length > 0 && !hasBroadManage) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      if (priority != null && !hasBroadManage) {
        logger.warn(
          `[adminConfig] Ignoring caller-supplied priority on assign-only scope lifecycle upsert to ${principalType}/${principalId}: only broad manage:configs may modify document priority`,
        );
      }

      const requestedPriority = hasBroadManage ? (priority ?? DEFAULT_PRIORITY) : DEFAULT_PRIORITY;
      const upsertOptions = hasBroadManage
        ? { expectEmpty: false }
        : { expectEmpty: true, preservePriority: true };

      for (const section of getConfigSecretSections()) {
        const secretInputError = getConfigSecretInputError(
          section,
          (filteredOverrides as Record<string, unknown>)[section],
        );
        if (secretInputError) {
          return res.status(400).json({ error: secretInputError });
        }
      }

      const encryptedOverrides = encryptConfigSecrets(filteredOverrides);
      const overrideIssues = getConfigOverrideIssues(encryptedOverrides);
      if (overrideIssues.length > 0) {
        return invalidOverrideResponse(res, overrideIssues);
      }
      const needsExistingSecrets = getConfigSecretSections().some((section) =>
        isConfigSecretPreservablePatch(
          section,
          (filteredOverrides as Record<string, unknown>)[section],
        ),
      );
      const needsProtectedBaseSections =
        principalId === BASE_CONFIG_PRINCIPAL_ID &&
        (overrideSections.length > 0 || priority != null);
      const existingConfig =
        needsExistingSecrets || needsProtectedBaseSections
          ? await findConfigByPrincipal(principalType, principalId, { includeInactive: true })
          : null;
      const preservedOverrides = preserveConfigSecrets(
        encryptedOverrides,
        existingConfig?.overrides,
      );
      if (needsProtectedBaseSections) {
        for (const section of BASE_PRINCIPAL_OVERRIDE_SECTIONS) {
          const storedSection = (
            existingConfig?.overrides as Record<string, unknown> | undefined
          )?.[section];
          if (storedSection !== undefined) {
            (preservedOverrides as Record<string, unknown>)[section] = storedSection;
          }
        }
      }
      const config = await upsertConfig(
        principalType,
        principalId,
        principalModel(principalType),
        preservedOverrides,
        requestedPriority,
        undefined,
        upsertOptions,
      );
      if (!config && !hasBroadManage) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      invalidateConfigCaches?.(user.tenantId)?.catch((err) =>
        logger.error('[adminConfig] Cache invalidation failed after upsert:', err),
      );
      return res.status(config?.configVersion === 1 ? 201 : 200).json({
        config: config ? redactConfigForResponse(config) : config,
      });
    } catch (error) {
      logger.error('[adminConfig] upsertConfigOverrides error:', error);
      return res.status(500).json({ error: 'Failed to upsert config' });
    }
  }

  /**
   * PATCH /:principalType/:principalId/fields — Set individual fields via dot-paths.
   */
  async function patchConfigField(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return res.status(400).json({ error: `Invalid principalType: ${principalType}` });
      }

      const { entries, priority } = req.body as {
        entries?: Array<{ fieldPath: string; value: unknown }>;
        priority?: number;
      };

      if (priority != null && (typeof priority !== 'number' || priority < 0)) {
        return res.status(400).json({ error: 'priority must be a non-negative number' });
      }

      if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: 'entries array is required and must not be empty' });
      }

      if (entries.length > MAX_PATCH_ENTRIES) {
        return res
          .status(400)
          .json({ error: `entries array exceeds maximum of ${MAX_PATCH_ENTRIES}` });
      }

      for (const entry of entries) {
        if (!isValidFieldPath(entry.fieldPath)) {
          return res
            .status(400)
            .json({ error: `Invalid or unsafe field path: ${entry.fieldPath}` });
        }
        if (isProcessMCPServerFieldPath(entry.fieldPath, entry.value)) {
          return res.status(400).json({ error: PROCESS_MCP_CONFIG_ERROR });
        }
        if (isLangfuseHeadersFieldPath(entry.fieldPath)) {
          return res.status(400).json({ error: LANGFUSE_HEADERS_CONFIG_ERROR });
        }
        if (isConfigSecretDescendantPath(entry.fieldPath)) {
          return res
            .status(400)
            .json({ error: `Cannot patch inside protected secret path: ${entry.fieldPath}` });
        }
        const secretInputError = getConfigSecretInputError(entry.fieldPath, entry.value);
        if (secretInputError) {
          return res.status(400).json({ error: secretInputError });
        }
        if (Array.isArray(entry.value) && isConfigSecretAncestorPath(entry.fieldPath)) {
          return res.status(400).json({
            error: `Cannot patch protected secret ancestor as an array: ${entry.fieldPath}`,
          });
        }
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const validEntries = entries
        .map((entry) => ({
          ...entry,
          value: normalizeInterfaceFieldPatch(entry.fieldPath, entry.value),
        }))
        .filter((entry) => {
          if (isBaseOnlyFieldPath(entry.fieldPath)) {
            logger.warn(
              `[adminConfig] Stripping base-only config field "${entry.fieldPath}" - configure it in librechat.yaml instead`,
            );
            return false;
          }
          if (BASE_PRINCIPAL_OVERRIDE_SECTIONS.has(getTopLevelSection(entry.fieldPath))) {
            logger.warn(
              `[adminConfig] Stripping dedicated tenant-wide config field "${entry.fieldPath}" from the generic config API`,
            );
            return false;
          }
          if (isInterfacePermissionPath(entry.fieldPath)) {
            logger.warn(
              `[adminConfig] Stripping interface permission field "${entry.fieldPath}" — use role permissions instead`,
            );
            return false;
          }
          return true;
        });

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      if (validEntries.length === 0) {
        if (!hasBroadManage) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
        return res.status(200).json({ message: 'No actionable field entries provided' });
      }

      if (!hasBroadManage) {
        const sections = [...new Set(validEntries.map((e) => getTopLevelSection(e.fieldPath)))];
        const allowed = await Promise.all(
          sections.map((s) => hasConfigCapability(user, s as ConfigSection, 'manage')),
        );
        const denied = sections.find((_, i) => !allowed[i]);
        if (denied) {
          return res.status(403).json({
            error: `Insufficient permissions for config section: ${denied}`,
          });
        }
      }

      const seen = new Set<string>();
      const fields: Record<string, unknown> = {};
      for (const entry of validEntries) {
        if (seen.has(entry.fieldPath)) {
          return res.status(400).json({ error: `Duplicate fieldPath: ${entry.fieldPath}` });
        }
        seen.add(entry.fieldPath);
        fields[entry.fieldPath] = entry.value;
      }

      if (priority != null && !hasBroadManage) {
        logger.warn(
          `[adminConfig] Ignoring caller-supplied priority on section-scoped patch to ${principalType}/${principalId}: only broad manage:configs may modify document priority`,
        );
      }
      const requestedPriority = hasBroadManage ? priority : undefined;

      const hasObjectValuedSecretPatch = Object.entries(fields).some(([fieldPath, value]) =>
        isConfigSecretPreservablePatch(fieldPath, value),
      );
      const existing =
        requestedPriority == null || hasObjectValuedSecretPatch
          ? await findConfigByPrincipal(principalType, principalId, { includeInactive: true })
          : null;
      const encryptedFields = encryptConfigSecretFields(fields);
      const fieldIssues = Object.entries(encryptedFields).flatMap(([fieldPath, value]) =>
        getConfigOverrideIssues(value, fieldPath),
      );
      if (fieldIssues.length > 0) {
        return invalidOverrideResponse(res, fieldIssues);
      }
      const preservedFields = preservePatchedConfigSecretFields(
        encryptedFields,
        existing?.overrides,
      );

      const config = await patchConfigFields(
        principalType,
        principalId,
        principalModel(principalType),
        preservedFields,
        requestedPriority ?? existing?.priority ?? DEFAULT_PRIORITY,
      );

      invalidateConfigCaches?.(user.tenantId)?.catch((err) =>
        logger.error('[adminConfig] Cache invalidation failed after patch:', err),
      );
      return res.status(200).json({ config: config ? redactConfigForResponse(config) : config });
    } catch (error) {
      logger.error('[adminConfig] patchConfigField error:', error);
      return res.status(500).json({ error: 'Failed to patch config fields' });
    }
  }

  /**
   * POST /:principalType/:principalId/fields/tombstone — Suppress an inherited config path.
   */
  async function tombstoneConfigField(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return res.status(400).json({ error: `Invalid principalType: ${principalType}` });
      }

      const { fieldPath, priority } = req.body as {
        fieldPath?: string;
        priority?: number;
      };

      if (!fieldPath || typeof fieldPath !== 'string') {
        return res.status(400).json({ error: 'fieldPath is required' });
      }

      if (priority != null && (typeof priority !== 'number' || priority < 0)) {
        return res.status(400).json({ error: 'priority must be a non-negative number' });
      }

      if (!isValidFieldPath(fieldPath)) {
        return res.status(400).json({ error: `Invalid or unsafe field path: ${fieldPath}` });
      }
      const secretInputError = getConfigSecretInputError(fieldPath, undefined);
      if (secretInputError) {
        return res.status(400).json({ error: secretInputError });
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const section = getTopLevelSection(fieldPath);

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      if (
        !hasBroadManage &&
        !(await hasConfigCapability(user, section as ConfigSection, 'manage'))
      ) {
        return res.status(403).json({
          error: `Insufficient permissions for config section: ${section}`,
        });
      }

      if (isBaseOnlyFieldPath(fieldPath)) {
        logger.warn(
          `[adminConfig] Ignoring tombstone for base-only config field "${fieldPath}" - configure it in librechat.yaml instead`,
        );
        return res.status(200).json({ message: 'No actionable field path provided' });
      }

      if (isInterfacePermissionPath(fieldPath)) {
        logger.warn(
          `[adminConfig] Ignoring tombstone for interface permission field "${fieldPath}" — use role permissions instead`,
        );
        return res.status(200).json({ message: 'No actionable field path provided' });
      }
      if (BASE_PRINCIPAL_OVERRIDE_SECTIONS.has(section)) {
        logger.warn(
          `[adminConfig] Ignoring dedicated tenant-wide config tombstone "${fieldPath}" in the generic config API`,
        );
        return res.status(200).json({ message: 'No actionable field path provided' });
      }

      if (priority != null && !hasBroadManage) {
        logger.warn(
          `[adminConfig] Ignoring caller-supplied priority on section-scoped tombstone for ${principalType}/${principalId}: only broad manage:configs may modify document priority`,
        );
      }
      const requestedPriority = hasBroadManage ? priority : undefined;

      const existing =
        requestedPriority == null
          ? await findConfigByPrincipal(principalType, principalId, { includeInactive: true })
          : null;

      let config: IConfig | null = null;
      for (const path of getConfigSecretMutationPaths(fieldPath)) {
        const fieldConfig = await writeConfigTombstone(
          principalType,
          principalId,
          principalModel(principalType),
          path,
          requestedPriority ?? existing?.priority ?? DEFAULT_PRIORITY,
        );
        if (fieldConfig) {
          config = fieldConfig;
        }
      }

      invalidateConfigCaches?.(user.tenantId)?.catch((err) =>
        logger.error('[adminConfig] Cache invalidation failed after field tombstone:', err),
      );
      return res.status(200).json({ config: config ? redactConfigForResponse(config) : config });
    } catch (error) {
      logger.error('[adminConfig] tombstoneConfigField error:', error);
      return res.status(500).json({ error: 'Failed to tombstone config field' });
    }
  }

  /**
   * DELETE /:principalType/:principalId/fields?fieldPath=dotted.path
   */
  async function deleteConfigField(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };
      if (!validatePrincipalType(principalType)) {
        return res.status(400).json({ error: `Invalid principalType: ${principalType}` });
      }

      const fieldPath = req.query.fieldPath as string | undefined;

      if (!fieldPath || typeof fieldPath !== 'string') {
        return res.status(400).json({ error: 'fieldPath query parameter is required' });
      }

      if (!isValidFieldPath(fieldPath)) {
        return res.status(400).json({ error: `Invalid or unsafe field path: ${fieldPath}` });
      }
      const secretInputError = getConfigSecretInputError(fieldPath, undefined);
      if (secretInputError) {
        return res.status(400).json({ error: secretInputError });
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const section = getTopLevelSection(fieldPath);

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      if (
        !hasBroadManage &&
        !(await hasConfigCapability(user, section as ConfigSection, 'manage'))
      ) {
        return res.status(403).json({
          error: `Insufficient permissions for config section: ${section}`,
        });
      }

      if (isBaseOnlyFieldPath(fieldPath)) {
        logger.warn(
          `[adminConfig] Ignoring delete for base-only config field "${fieldPath}" - configure it in librechat.yaml instead`,
        );
        return res.status(200).json({ message: 'No actionable field path provided' });
      }

      if (BASE_PRINCIPAL_OVERRIDE_SECTIONS.has(section)) {
        logger.warn(
          `[adminConfig] Ignoring dedicated tenant-wide config delete "${fieldPath}" in the generic config API`,
        );
        return res.status(200).json({ message: 'No actionable field path provided' });
      }

      if (isInterfacePermissionPath(fieldPath)) {
        logger.warn(
          `[adminConfig] Ignoring delete for interface permission field "${fieldPath}" — use role permissions instead`,
        );
        return res.status(200).json({ message: 'No actionable field path provided' });
      }

      let config: IConfig | null = null;
      for (const path of getConfigSecretMutationPaths(fieldPath)) {
        const fieldConfig = await unsetConfigField(principalType, principalId, path);
        if (fieldConfig) {
          config = fieldConfig;
        }
      }
      if (!config) {
        return res.status(404).json({ error: 'Config not found' });
      }

      invalidateConfigCaches?.(user.tenantId)?.catch((err) =>
        logger.error('[adminConfig] Cache invalidation failed after field delete:', err),
      );
      return res.status(200).json({ config: redactConfigForResponse(config) });
    } catch (error) {
      logger.error('[adminConfig] deleteConfigField error:', error);
      return res.status(500).json({ error: 'Failed to delete config field' });
    }
  }

  /**
   * DELETE /:principalType/:principalId — Delete an entire config override.
   */
  async function deleteConfigOverrides(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return res.status(400).json({ error: `Invalid principalType: ${principalType}` });
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const allowed =
        hasBroadManage ||
        (await hasCapability(user, `assign:configs:${principalType}` as SystemCapability));
      if (!allowed) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const config = await deleteConfig(principalType, principalId, undefined, {
        expectEmpty: !hasBroadManage,
      });
      if (!config) {
        if (!hasBroadManage) {
          const exists = await findConfigByPrincipal(principalType, principalId, {
            includeInactive: true,
          });
          if (exists) {
            return res.status(403).json({ error: 'Insufficient permissions' });
          }
        }
        return res.status(404).json({ error: 'Config not found' });
      }

      invalidateConfigCaches?.(user.tenantId)?.catch((err) =>
        logger.error('[adminConfig] Cache invalidation failed after config delete:', err),
      );
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminConfig] deleteConfigOverrides error:', error);
      return res.status(500).json({ error: 'Failed to delete config' });
    }
  }

  /**
   * PATCH /:principalType/:principalId/active — Toggle isActive.
   */
  async function toggleConfig(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return res.status(400).json({ error: `Invalid principalType: ${principalType}` });
      }

      const { isActive } = req.body as { isActive?: boolean };
      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive boolean is required' });
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const allowed =
        hasBroadManage ||
        (await hasCapability(user, `assign:configs:${principalType}` as SystemCapability));
      if (!allowed) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const config = await toggleConfigActive(principalType, principalId, isActive, undefined, {
        expectEmpty: !hasBroadManage,
      });
      if (!config) {
        if (!hasBroadManage) {
          const exists = await findConfigByPrincipal(principalType, principalId, {
            includeInactive: true,
          });
          if (exists) {
            return res.status(403).json({ error: 'Insufficient permissions' });
          }
        }
        return res.status(404).json({ error: 'Config not found' });
      }

      invalidateConfigCaches?.(user.tenantId)?.catch((err) =>
        logger.error('[adminConfig] Cache invalidation failed after toggle:', err),
      );
      return res.status(200).json({ config: redactConfigForResponse(config) });
    } catch (error) {
      logger.error('[adminConfig] toggleConfig error:', error);
      return res.status(500).json({ error: 'Failed to toggle config' });
    }
  }

  return {
    listConfigs,
    getBaseConfig,
    getConfig,
    upsertConfigOverrides,
    patchConfigField,
    tombstoneConfigField,
    deleteConfigField,
    deleteConfigOverrides,
    toggleConfig,
  };
}
