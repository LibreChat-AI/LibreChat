import {
  BASE_PRINCIPAL_CONFIG_SECTIONS,
  BASE_ONLY_CONFIG_SECTIONS,
  INTERFACE_PERMISSION_FIELDS,
  RUNTIME_CONFIG_INTERFACE_FIELDS,
  PERMISSION_SUB_KEYS,
  isProcessMCPServerConfig,
  getConfigOverrideIssues,
} from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { AppConfig, IConfig } from '~/types';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import logger from '~/config/winston';

type AnyObject = { [key: string]: unknown };

const MAX_MERGE_DEPTH = 10;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Filters are a fail-closed security boundary even during mixed-package rollouts. */
const BASE_ONLY_OVERRIDE_SECTIONS = new Set<string>(['filters', ...BASE_ONLY_CONFIG_SECTIONS]);
const BASE_PRINCIPAL_OVERRIDE_SECTIONS = new Set<string>(BASE_PRINCIPAL_CONFIG_SECTIONS);

/**
 * Paths within the config tree where arrays of objects should be merged by
 * a key field rather than replaced wholesale. `deepMerge` matches items by
 * the given key, deep-merges matching pairs, preserves unmatched base items,
 * and appends new override-only items.
 *
 * Paths use AppConfig key names (post-OVERRIDE_KEY_MAP remapping),
 * not YAML-level key names. E.g. use `interfaceConfig.x`, not `interface.x`.
 */
const ARRAY_MERGE_KEYS: Record<string, string> = {
  'endpoints.custom': 'name',
};

/**
 * Maps YAML-level override keys (TCustomConfig) to their AppConfig equivalents.
 * Overrides are stored with YAML keys but merged into the already-processed AppConfig
 * where some fields have been renamed by AppService.
 *
 * When AppService renames a field, add the mapping here. Map entries are
 * type-checked: keys must be valid TCustomConfig fields, values must be
 * valid AppConfig fields. The runtime lookup casts string keys to satisfy
 * strict indexing — unknown keys safely fall through via the ?? fallback.
 */
const OVERRIDE_KEY_MAP: Partial<Record<keyof TCustomConfig, keyof AppConfig>> = {
  mcpServers: 'mcpConfig',
  interface: 'interfaceConfig',
  turnstile: 'turnstileConfig',
};

function isSafePath(path: string): boolean {
  const segments = path.split('.');
  if (
    path.length === 0 ||
    path.startsWith('.') ||
    path.endsWith('.') ||
    path.includes('..') ||
    segments.some((segment) => segment.length === 0 || UNSAFE_KEYS.has(segment))
  ) {
    return false;
  }
  return true;
}

function remapOverridePath(path: string): string {
  const [first, ...rest] = path.split('.');
  const mappedFirst = OVERRIDE_KEY_MAP[first as keyof typeof OVERRIDE_KEY_MAP] ?? first;
  return [mappedFirst, ...rest].join('.');
}

function isBaseOnlyOverridePath(path: string): boolean {
  return BASE_ONLY_OVERRIDE_SECTIONS.has(path.split('.')[0]);
}

function deletePath<T extends AnyObject>(target: T, path: string): T {
  if (!isSafePath(path)) {
    return target;
  }

  const segments = path.split('.');
  const result = { ...target } as AnyObject;
  let cursor: AnyObject = result;

  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    const value = cursor[segment];
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      return result as T;
    }
    const cloned = { ...(value as AnyObject) };
    cursor[segment] = cloned;
    cursor = cloned;
  }

  delete cursor[segments[segments.length - 1]];
  return result as T;
}

function deleteConfigPath<T extends AnyObject>(target: T, path: string): T {
  const [section, serverName] = path.split('.');
  if (section !== 'mcpConfig') {
    return deletePath(target, path);
  }

  const mcpConfig = target.mcpConfig;
  if (mcpConfig == null || typeof mcpConfig !== 'object' || Array.isArray(mcpConfig)) {
    return deletePath(target, path);
  }

  const servers = mcpConfig as AnyObject;
  if (serverName != null) {
    return isProcessMCPServerConfig(servers[serverName]) ? target : deletePath(target, path);
  }

  const processServers = Object.fromEntries(
    Object.entries(servers).filter(([, serverConfig]) => isProcessMCPServerConfig(serverConfig)),
  );
  if (Object.keys(processServers).length === 0) {
    return deletePath(target, path);
  }

  return { ...target, mcpConfig: processServers } as T;
}

function mergeArrayByKey(
  target: AnyObject[],
  source: AnyObject[],
  keyField: string,
  depth: number,
  path: string,
): AnyObject[] {
  const sourceByKey = new Map<unknown, AnyObject>();
  for (const item of source) {
    if (item != null && typeof item === 'object') {
      const key = item[keyField];
      // Source items without a key value are skipped: no stable identity
      // for matching or appending. (Keyless target items are preserved as-is below.)
      if (key != null) {
        sourceByKey.set(key, item);
      }
    }
  }

  const result: AnyObject[] = [];
  const seen = new Set<unknown>();

  // Pass the array container path (not a per-element path) so item
  // properties build paths like 'endpoints.custom.baseURL' for any
  // nested ARRAY_MERGE_KEYS lookups.
  for (const item of target) {
    if (item != null && typeof item === 'object') {
      const key = item[keyField];
      const override = key != null ? sourceByKey.get(key) : undefined;
      if (override) {
        result.push(deepMerge(item, override, depth + 1, path));
        seen.add(key);
      } else {
        result.push({ ...item });
      }
    } else {
      result.push(item);
    }
  }

  for (const key of sourceByKey.keys()) {
    if (!seen.has(key)) {
      result.push(deepMerge({} as AnyObject, sourceByKey.get(key)!, depth + 1, path));
    }
  }

  return result;
}

function deepMerge<T extends AnyObject>(target: T, source: AnyObject, depth = 0, path = ''): T {
  const result = { ...target } as AnyObject;
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) {
      continue;
    }
    const currentPath = path ? `${path}.${key}` : key;
    const sourceVal = source[key];
    const targetVal = result[key];
    if (
      depth < MAX_MERGE_DEPTH &&
      sourceVal != null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal != null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as AnyObject,
        sourceVal as AnyObject,
        depth + 1,
        currentPath,
      );
    } else if (
      depth < MAX_MERGE_DEPTH &&
      Array.isArray(sourceVal) &&
      Array.isArray(targetVal) &&
      ARRAY_MERGE_KEYS[currentPath]
    ) {
      result[key] = mergeArrayByKey(
        targetVal as AnyObject[],
        sourceVal as AnyObject[],
        ARRAY_MERGE_KEYS[currentPath],
        depth,
        currentPath,
      );
    } else if (
      typeof sourceVal === 'boolean' &&
      targetVal != null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal) &&
      RUNTIME_CONFIG_INTERFACE_FIELDS.has(key)
    ) {
      // A runtime-config interface field (e.g. schedules) toggled by a boolean
      // override is a runtime enable/disable, not a replacement of its config. Fold
      // the boolean into the `use` flag so inherited object-form limits (maxPerUser,
      // minIntervalMinutes, ...) survive instead of collapsing to global defaults.
      result[key] = { ...(targetVal as AnyObject), use: sourceVal };
    } else if (
      typeof targetVal === 'boolean' &&
      sourceVal != null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      RUNTIME_CONFIG_INTERFACE_FIELDS.has(key)
    ) {
      // Symmetric case: an OBJECT override (e.g. tuning maxPerUser) on top of a
      // BOOLEAN base must inherit the base's enable state unless it sets `use`
      // explicitly — otherwise setting a limit on a globally-disabled feature
      // (`schedules: false`) would silently re-enable it.
      result[key] = { use: targetVal, ...(sourceVal as AnyObject) };
    } else {
      result[key] = sourceVal;
    }
  }
  return result as T;
}

function omitPath(target: unknown, segments: string[]): unknown {
  const [segment, ...rest] = segments;
  if (Array.isArray(target)) {
    const index = Number(segment);
    if (!Number.isInteger(index) || index < 0 || index >= target.length) {
      return target;
    }
    const next = [...target];
    if (rest.length === 0) {
      next.splice(index, 1);
    } else {
      next[index] = omitPath(next[index], rest);
    }
    return next;
  }
  if (target == null || typeof target !== 'object' || !(segment in target)) {
    return target;
  }
  const next = { ...(target as AnyObject) };
  if (rest.length === 0) {
    delete next[segment];
  } else {
    next[segment] = omitPath(next[segment], rest);
  }
  return next;
}

/**
 * Drops override fields that fail `configSchema`, so an invalid stored value (written
 * before write-time validation, or by an older server) leaves the base value in place
 * instead of replacing it.
 */
function stripInvalidOverrides(config: IConfig): AnyObject {
  const overrides = config.overrides as AnyObject;
  const issues = getConfigOverrideIssues(overrides);
  if (issues.length === 0) {
    return overrides;
  }
  let stripped: unknown = overrides;
  for (let index = issues.length - 1; index >= 0; index--) {
    const { path, segments, message } = issues[index];
    logger.warn(
      `[mergeConfigOverrides] Ignoring invalid override "${path}" for ${config.principalType}/${config.principalId}: ${message}`,
    );
    stripped = omitPath(stripped, segments);
  }
  return stripped as AnyObject;
}

function filterMCPServerOverrides(value: unknown, current: unknown): AnyObject {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const currentServers =
    current != null && typeof current === 'object' && !Array.isArray(current)
      ? (current as AnyObject)
      : {};
  const filtered: AnyObject = {};

  for (const [serverName, serverOverride] of Object.entries(value)) {
    const currentServer = currentServers[serverName];
    if (
      serverOverride == null ||
      typeof serverOverride !== 'object' ||
      Array.isArray(serverOverride)
    ) {
      if (!isProcessMCPServerConfig(currentServer)) {
        filtered[serverName] = serverOverride;
      }
      continue;
    }

    const baseServer =
      currentServer != null && typeof currentServer === 'object' && !Array.isArray(currentServer)
        ? (currentServer as AnyObject)
        : {};
    const resolved = deepMerge(baseServer, serverOverride as AnyObject);
    if (!isProcessMCPServerConfig(resolved)) {
      filtered[serverName] = serverOverride;
    }
  }

  return filtered;
}

/**
 * Merge DB config overrides into a base AppConfig.
 *
 * Configs are sorted by priority ascending (lowest first, highest wins).
 * Each config's `overrides` is deep-merged into the base config in order.
 */
export function mergeConfigOverrides(baseConfig: AppConfig, configs: IConfig[]): AppConfig {
  if (!configs || configs.length === 0) {
    return baseConfig;
  }

  const sorted = [...configs].sort((a, b) => a.priority - b.priority);

  let merged = { ...baseConfig };
  for (const config of sorted) {
    const isBasePrincipal = config.principalId?.toString() === BASE_CONFIG_PRINCIPAL_ID;
    if (Array.isArray(config.tombstones)) {
      for (const path of config.tombstones) {
        if (
          typeof path === 'string' &&
          !isBaseOnlyOverridePath(path) &&
          (isBasePrincipal || !BASE_PRINCIPAL_OVERRIDE_SECTIONS.has(path.split('.')[0]))
        ) {
          merged = deleteConfigPath(merged, remapOverridePath(path));
        }
      }
    }

    if (config.overrides && typeof config.overrides === 'object') {
      const remapped: AnyObject = {};
      for (const [key, value] of Object.entries(stripInvalidOverrides(config))) {
        if (
          BASE_ONLY_OVERRIDE_SECTIONS.has(key) ||
          (!isBasePrincipal && BASE_PRINCIPAL_OVERRIDE_SECTIONS.has(key))
        ) {
          continue;
        }
        const mappedKey = OVERRIDE_KEY_MAP[key as keyof typeof OVERRIDE_KEY_MAP] ?? key;
        if (mappedKey === 'mcpConfig') {
          remapped[mappedKey] = filterMCPServerOverrides(
            value,
            (merged as unknown as AnyObject)[mappedKey],
          );
        } else if (
          key === 'interface' &&
          value != null &&
          typeof value === 'object' &&
          !Array.isArray(value)
        ) {
          const filtered: AnyObject = {};
          for (const [field, fieldVal] of Object.entries(value as AnyObject)) {
            if (!INTERFACE_PERMISSION_FIELDS.has(field)) {
              filtered[field] = fieldVal;
            } else if (
              fieldVal != null &&
              typeof fieldVal === 'object' &&
              !Array.isArray(fieldVal)
            ) {
              // Composite permission field (e.g. mcpServers): strip permission
              // sub-keys but preserve UI-only sub-keys like placeholder/trustCheckbox.
              const uiOnly: AnyObject = {};
              for (const [sub, subVal] of Object.entries(fieldVal as AnyObject)) {
                if (!PERMISSION_SUB_KEYS.has(sub)) {
                  uiOnly[sub] = subVal;
                }
              }
              if (Object.keys(uiOnly).length > 0) {
                filtered[field] = uiOnly;
              }
            } else if (RUNTIME_CONFIG_INTERFACE_FIELDS.has(field)) {
              // Dual-purpose field: the boolean form is a runtime disable, not a
              // permission toggle, so preserve it (e.g. schedules: false).
              filtered[field] = fieldVal;
            }
            // other boolean permission fields (e.g. runCode: false) are fully stripped
          }
          if (Object.keys(filtered).length > 0) {
            remapped[mappedKey] = filtered;
          }
        } else {
          remapped[mappedKey] = value;
        }
      }
      merged = deepMerge(merged, remapped);
    }
  }

  return preserveRuntimeStops(baseConfig, merged);
}

/** Whether a runtime-config interface field reads as OFF in either of its two shapes:
 *  boolean `false`, or the object form with `use: false`. Exported so runtime gates
 *  (e.g. the schedule engine's global stop) apply the same semantics as the merge. */
export function isRuntimeDisabled(value: unknown): boolean {
  if (value === false) {
    return true;
  }
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as AnyObject).use === false
  );
}

/**
 * Re-applies a BASE-level runtime stop after all overrides are merged.
 *
 * A deployment that turns a runtime feature off is not making a preference an override
 * can outrank: the service reads the base value and keeps refusing writes, so an
 * override that only flips the client's view produces a panel whose every action fails.
 *
 * Applied here rather than inside the merge deliberately. The merge folds overrides in
 * priority order into an ACCUMULATED value, so a guard there compares against whatever
 * the previous override left — which let a LOW-priority `false` block a HIGH-priority
 * `true` and broke highest-priority-wins. Overrides still order normally among
 * themselves; only the base stop is non-negotiable.
 */
function preserveRuntimeStops<T extends AppConfig>(baseConfig: AppConfig, merged: T): T {
  const baseInterface = (baseConfig as unknown as AnyObject).interfaceConfig as
    | AnyObject
    | undefined;
  const mergedInterface = (merged as unknown as AnyObject).interfaceConfig as AnyObject | undefined;
  if (baseInterface == null || mergedInterface == null) {
    return merged;
  }
  let patched: AnyObject | undefined;
  for (const key of RUNTIME_CONFIG_INTERFACE_FIELDS) {
    if (!isRuntimeDisabled(baseInterface[key]) || isRuntimeDisabled(mergedInterface[key])) {
      continue;
    }
    const current = mergedInterface[key];
    patched ??= { ...mergedInterface };
    patched[key] =
      current != null && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as AnyObject), use: false }
        : false;
  }
  if (patched == null) {
    return merged;
  }
  return { ...(merged as unknown as AnyObject), interfaceConfig: patched } as unknown as T;
}
