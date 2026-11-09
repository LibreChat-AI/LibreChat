import { getConfigMergeRules } from '@librechat/data-schemas';
import {
  Constants,
  configSchema,
  PERMISSION_SUB_KEYS,
  BASE_ONLY_CONFIG_PATHS,
  DATA_PROVIDER_VERSION,
  DEPLOYMENT_ONLY_CONFIG_PATHS,
  BASE_ONLY_CONFIG_SECTIONS,
  PROCESS_MCP_SERVER_FIELDS,
  INTERFACE_PERMISSION_FIELDS,
  BASE_PRINCIPAL_CONFIG_SECTIONS,
  DEFAULT_CATALOG_MODELS_TTL_MS,
  RUNTIME_CONFIG_INTERFACE_FIELDS,
} from 'librechat-data-provider';
import type { AppConfig, AdminConfigFeatures, AdminConfigMeta } from '@librechat/data-schemas';
import { RENAME_HINT_PATHS, getConfigSecretRules } from './secrets';

/**
 * How long `GET /catalog` reuses a scope's model lists while its endpoint config is unchanged:
 * `endpoints.catalogModelsTtlMs`, which only librechat.yaml sets, or two minutes.
 */
export function getCatalogModelsTtlMs(config: AppConfig | undefined): number {
  return config?.endpoints?.catalogModelsTtlMs ?? DEFAULT_CATALOG_MODELS_TTL_MS;
}

/**
 * The admin config behaviours this server has. A change flips its own flag when it wires the
 * behaviour; `meta.spec.ts` checks every flag against the behaviour itself, so a flag cannot
 * claim what the server does not do, nor stay off once it does. `endpointRederive` is reported
 * only where the deployment turns it on (`buildAdminConfigMeta`).
 */
export const ADMIN_CONFIG_FEATURES: Readonly<AdminConfigFeatures> = {
  dottedKeys: true,
  sectionAllowlist: true,
  readFilteredWriteResponses: true,
  preAuthBaseOverrides: true,
  webSearchStoredKeys: true,
  expectedRevision: true,
  prunesEmptyParents: true,
  awaitedInvalidation: true,
  changesBatch: true,
  yamlMcpHide: true,
  deterministicPrecedence: true,
  priorityRoute: true,
  principalCheck: true,
  roleRenameMovesProfile: true,
  recordSecrets: true,
  azureGroupSecrets: true,
  yamlSecretPreview: true,
  envAllowlist: true,
  secretRebinding: true,
  resolvedApi: true,
  catalogApi: true,
  envStatus: true,
  reloadRoute: true,
  writeReport: true,
  issueParams: true,
  adminTermsExempt: true,
  keyedTombstones: true,
  renameHints: true,
  azureGroupMergeKey: true,
  customParamsExpansion: true,
  specInterfaceRederive: true,
  endpointRederive: true,
};

/** How this server runs, for the behaviours a deployment switches on. */
export interface AdminConfigRuntime {
  /**
   * `CONFIG_REDERIVE_ENDPOINTS`: Azure groups, Vertex AI and Azure Assistants derived from
   * overrides again.
   */
  rederiveEndpoints?: boolean;
}

/**
 * The contract `GET /api/admin/config/meta` reports, built from the constants the server
 * enforces rather than restated, so the rules a client mirrors cannot drift from them. A flag a
 * deployment switches on (`endpointRederive`) is on only when it is, and implemented.
 */
export function buildAdminConfigMeta(
  limits: AdminConfigMeta['limits'],
  runtime: AdminConfigRuntime = {},
): AdminConfigMeta {
  return {
    metaVersion: 1,
    versions: {
      librechat: String(Constants.VERSION),
      dataProvider: DATA_PROVIDER_VERSION,
      configSchema: String(Constants.CONFIG_VERSION),
    },
    features: {
      ...ADMIN_CONFIG_FEATURES,
      endpointRederive:
        ADMIN_CONFIG_FEATURES.endpointRederive && runtime.rederiveEndpoints === true,
    },
    limits: { ...limits },
    rules: {
      acceptedSections: Object.keys(configSchema.shape),
      renameHintPaths: [...RENAME_HINT_PATHS],
      baseOnlySections: [...BASE_ONLY_CONFIG_SECTIONS],
      basePrincipalSections: [...BASE_PRINCIPAL_CONFIG_SECTIONS],
      baseOnlyPaths: [...BASE_ONLY_CONFIG_PATHS],
      deploymentOnlyPaths: { ...DEPLOYMENT_ONLY_CONFIG_PATHS },
      ...getConfigMergeRules(),
      ...getConfigSecretRules(),
      processMcpFields: [...PROCESS_MCP_SERVER_FIELDS],
      interface: {
        permissionFields: [...INTERFACE_PERMISSION_FIELDS],
        runtimeFields: [...RUNTIME_CONFIG_INTERFACE_FIELDS],
        permissionSubKeys: [...PERMISSION_SUB_KEYS],
      },
      titleResolution: 'field',
    },
  };
}
