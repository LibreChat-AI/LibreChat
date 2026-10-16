import { logger } from '@librechat/data-schemas';
import {
  BASE_PRINCIPAL_CONFIG_SECTIONS,
  BASE_ONLY_CONFIG_SECTIONS,
  INTERFACE_PERMISSION_FIELDS,
  RUNTIME_CONFIG_INTERFACE_FIELDS,
  PERMISSION_SUB_KEYS,
  hasProcessMCPServerConfig,
} from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import {
  encryptConfigSecrets,
  getConfigSecretInputError,
  getConfigSecretSections,
  preserveConfigSecrets,
} from '../secrets';

const BASE_ONLY_SECTIONS = new Set<string>(BASE_ONLY_CONFIG_SECTIONS);
const BASE_PRINCIPAL_SECTIONS = new Set<string>(BASE_PRINCIPAL_CONFIG_SECTIONS);

function hasLangfuseHeaders(overrides: Record<string, unknown>): boolean {
  if (
    Object.keys(overrides).some(
      (key) => key === 'langfuse.headers' || key.startsWith('langfuse.headers.'),
    )
  ) {
    return true;
  }
  const langfuse = overrides.langfuse;
  return (
    langfuse != null &&
    typeof langfuse === 'object' &&
    !Array.isArray(langfuse) &&
    Object.keys(langfuse).some((key) => key === 'headers' || key.startsWith('headers.'))
  );
}

function normalizeRuntimeInterfaceValue(field: string, value: unknown): unknown {
  if (!RUNTIME_CONFIG_INTERFACE_FIELDS.has(field)) {
    return value;
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  return (value as Record<string, unknown>).use === false ? false : value;
}

function filterInterface(value: unknown): Record<string, unknown> | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const filtered: Record<string, unknown> = {};
  for (const [field, rawValue] of Object.entries(value)) {
    const fieldValue = normalizeRuntimeInterfaceValue(field, rawValue);
    if (!INTERFACE_PERMISSION_FIELDS.has(field)) {
      filtered[field] = fieldValue;
    } else if (fieldValue != null && typeof fieldValue === 'object' && !Array.isArray(fieldValue)) {
      const uiOnly = Object.fromEntries(
        Object.entries(fieldValue).filter(([key]) => !PERMISSION_SUB_KEYS.has(key)),
      );
      if (Object.keys(uiOnly).length > 0) {
        filtered[field] = uiOnly;
      }
    } else if (RUNTIME_CONFIG_INTERFACE_FIELDS.has(field)) {
      filtered[field] = fieldValue;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

/** Validates and encrypts trusted role overrides before database storage. */
export function prepareConfigOverrides(
  overrides: Partial<TCustomConfig>,
  existingOverrides?: Partial<TCustomConfig>,
): Partial<TCustomConfig> {
  const values = { ...(overrides as Record<string, unknown>) };
  if (hasProcessMCPServerConfig(values.mcpServers) || hasProcessMCPServerConfig(values.mcpConfig)) {
    throw new TypeError('Process-backed MCP servers can only be configured in librechat.yaml');
  }
  if (hasLangfuseHeaders(values)) {
    throw new TypeError('Langfuse request headers can only be configured in librechat.yaml');
  }
  for (const key of Object.keys(values)) {
    const section = key.split('.')[0];
    if (BASE_ONLY_SECTIONS.has(section)) {
      delete values[key];
      logger.warn(
        `[roleConfig] Stripping base-only config section "${key}" - configure it in librechat.yaml instead`,
      );
    } else if (BASE_PRINCIPAL_SECTIONS.has(section)) {
      delete values[key];
      logger.warn(
        `[roleConfig] Stripping dedicated tenant-wide config section "${key}" from role configuration`,
      );
    }
  }
  if ('interface' in values) {
    const filteredInterface = filterInterface(values.interface);
    if (filteredInterface) {
      values.interface = filteredInterface;
    } else {
      delete values.interface;
    }
  }
  for (const section of getConfigSecretSections()) {
    const error = getConfigSecretInputError(section, values[section]);
    if (error) {
      throw new TypeError(error);
    }
  }
  return preserveConfigSecrets(
    encryptConfigSecrets(values as Partial<TCustomConfig>),
    existingOverrides,
  ) as Partial<TCustomConfig>;
}
