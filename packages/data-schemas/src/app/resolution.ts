import {
  BASE_PRINCIPAL_CONFIG_SECTIONS,
  BASE_ONLY_CONFIG_SECTIONS,
  BASE_ONLY_CONFIG_PATHS,
  DERIVED_CONFIG_PATHS,
  DEPLOYMENT_ONLY_CONFIG_PATHS,
  INTERFACE_PERMISSION_FIELDS,
  RUNTIME_CONFIG_INTERFACE_FIELDS,
  PERMISSION_SUB_KEYS,
  isProcessMCPServerConfig,
  EModelEndpoint,
  configSchema,
} from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type {
  AdminConfigLayerIgnoreReason,
  AdminConfigIgnoredOverride,
  AdminConfigIgnoreReason,
  AdminConfigLayerIgnored,
  AdminConfigMergeRules,
  ConfigIssueParams,
  TWebSearchKeys,
  AppConfig,
  Config,
} from '~/types';
import type { ConfigEntryRename, ConfigFieldWrite } from './mutations';
import type { ConfigDerivation, ConfigTouches } from './derive';
import type { ConfigEntryLocation } from './collections';
import type { AzureResolvedGroupField } from './azure';
import {
  MERGE_KEY_FOLDS,
  ARRAY_MERGE_KEYS,
  OVERRIDE_KEY_MAP,
  remapOverridePath,
  foldConfigMergeKey,
  isConfigEntryAt,
  readConfigEntryTombstone,
  getConfigEntryIdentity,
  getConfigArrayMergeKey,
  getConfigMergeArrayPath,
} from './collections';
import {
  AZURE_RESOLVED_GROUP_FIELDS,
  toAzureGroupMapEntry,
  completeAzureResolution,
  getEmptyAzureResolution,
  narrowAzureServedModels,
  lacksAzureAssistantModels,
  resolveServedAzureGroups,
} from './azure';
import {
  getGroupNames,
  isVertexConfigured,
  createConfigTouches,
  recordConfigTouches,
  deriveVertexEndpoint,
  rederiveMergedConfig,
  getDerivedConfigIssues,
  WRITE_ONLY_DERIVED_ISSUES,
} from './derive';
import { setConfigFields, toConfigOverrideState, renameConfigEntriesTombstones } from './mutations';
import { parseFieldPath, isDotFreePath, isSegmentPrefix, isKeyedConfigPath } from './paths';
import { isBaseConfigPrincipal, sortByConfigPrecedence } from './precedence';
import { webSearchPairedFields, unbindWebSearchKeys } from './web';
import logger from '~/config/winston';

type AnyObject = { [key: string]: unknown };

/** The parts of a principal's config document the merge reads, whichever store returned it. */
export type ConfigOverrideLayer = Pick<Config, 'principalType' | 'priority' | 'overrides'> & {
  principalId: { toString(): string };
  tombstones?: readonly unknown[];
  /** The document's identity: the last tie-break of merge precedence. */
  _id?: { toString(): string } | null;
};

const MAX_MERGE_DEPTH = 10;
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;
/** Schemas whose children the path walk cannot see, so the stored value decides their shape. */
const OPAQUE_SCHEMA_TYPES = new Set(['any', 'unknown', 'intersection']);
const MAX_STRIP_PASSES = 16;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Filters are a fail-closed security boundary even during mixed-package rollouts. */
const BASE_ONLY_OVERRIDE_SECTIONS = new Set<string>(['filters', ...BASE_ONLY_CONFIG_SECTIONS]);
const BASE_PRINCIPAL_OVERRIDE_SECTIONS = new Set<string>(BASE_PRINCIPAL_CONFIG_SECTIONS);

/** {@link DERIVED_CONFIG_PATHS}, the paths AppService derives and no layer writes, as segments. */
const DERIVED_PATH_SEGMENTS: ReadonlyArray<readonly string[]> = DERIVED_CONFIG_PATHS.map((path) =>
  path.split('.'),
);

/** Whether a path (override or AppConfig keys) is a derived path or lies inside one. */
export function isDerivedConfigPath(segments: readonly string[]): boolean {
  return DERIVED_PATH_SEGMENTS.some((path) => isSegmentPrefix(path, segments));
}

/**
 * A layer's overrides without the values it holds at derived paths (`DERIVED_CONFIG_PATHS`), each
 * told to `report` or, without one, warned about; the same object when it holds none.
 */
function withoutDerivedPaths(
  overrides: AnyObject,
  principal: string,
  report?: (segments: readonly string[]) => void,
): AnyObject {
  let result = overrides;
  for (const path of DERIVED_PATH_SEGMENTS) {
    if (getPath(result, [...path]) === undefined) {
      continue;
    }
    if (report) {
      report(path);
    } else {
      logger.warn(
        `[mergeConfigOverrides] Ignoring ${path.join('.')} for ${principal}: it is derived from librechat.yaml, not written`,
      );
    }
    result = omitPath(result, [...path]) as AnyObject;
  }
  return result;
}

/** A field only librechat.yaml sets, as YAML key segments, and why the merge keeps its value. */
export interface YamlHeldPath {
  segments: readonly string[];
  reason: Extract<AdminConfigIgnoreReason, 'base_only_path' | 'deployment_only_path'>;
}

/**
 * Every field the merge sets back to librechat.yaml's value whatever a layer stores or
 * tombstones there: `BASE_ONLY_CONFIG_PATHS`, which per-request code reads from the merged
 * config, and `DEPLOYMENT_ONLY_CONFIG_PATHS`, read at startup or from librechat.yaml itself.
 */
export const YAML_HELD_PATHS: readonly YamlHeldPath[] = [
  ...BASE_ONLY_CONFIG_PATHS.map(
    (path): YamlHeldPath => ({ segments: path.split('.'), reason: 'base_only_path' }),
  ),
  ...Object.keys(DEPLOYMENT_ONLY_CONFIG_PATHS).map(
    (path): YamlHeldPath => ({ segments: path.split('.'), reason: 'deployment_only_path' }),
  ),
];

/** Told about each stored override or tombstone of `layer` that a fold leaves out. */
type IgnoredSink = (layer: ConfigOverrideLayer, entry: AdminConfigIgnoredOverride) => void;

/** {@link IgnoredSink} bound to the layer being folded. */
type LayerIgnoredSink = (entry: AdminConfigIgnoredOverride) => void;

function toIgnored(
  segments: readonly string[],
  reason: AdminConfigIgnoreReason,
  kind: AdminConfigIgnoredOverride['kind'],
): AdminConfigIgnoredOverride {
  return { path: segments.join('.'), segments: [...segments], reason, kind };
}

/** Where the resolved Azure config sits in an AppConfig. */
const AZURE_CONFIG_PATH = `endpoints.${EModelEndpoint.azureOpenAI}`;

/** The resolved Azure fields a layer's `groups` replace, as AppConfig paths. */
const AZURE_RESOLVED_PATHS: readonly string[] = AZURE_RESOLVED_GROUP_FIELDS.map(
  (field) => `${AZURE_CONFIG_PATH}.${field}`,
);

/** Azure `groups`, as a librechat.yaml path (the same in an AppConfig). */
const AZURE_GROUPS_PATH = `${AZURE_CONFIG_PATH}.groups`;

/**
 * The paths a tombstone removes: its own, and for Azure `groups`, where the merge resolves them
 * (`resolvesAzureGroups`), every field they resolve to (`AZURE_RESOLVED_PATHS`), which the Azure
 * clients and model lists read in their place.
 */
function getTombstoneRemovals(path: string, resolvesAzureGroups: boolean): readonly string[] {
  return resolvesAzureGroups && path === AZURE_GROUPS_PATH
    ? [path, ...AZURE_RESOLVED_PATHS]
    : [path];
}

/**
 * `merged` with its Azure groups resolved to none, when it has an Azure endpoint: every field the
 * groups resolve to stays, empty, so the Azure clients and model lists serve no group. Their
 * absence would read differently: the model lists fall back to the environment's default Azure
 * models, which the Azure client, configured by librechat.yaml, cannot map to a group.
 */
function withoutAzureGroups<T extends AnyObject>(merged: T): T {
  const segments = AZURE_CONFIG_PATH.split('.');
  const azure = getPath(merged, segments);
  if (!isPlainObject(azure)) {
    return merged;
  }
  return setPath(merged, segments, { ...azure, ...getEmptyAzureResolution() }) as T;
}

/**
 * Object-valued paths an override replaces whole instead of merging into. A theme
 * definition is one coherent value: merging two would keep the base theme's modes,
 * brands and tokens under the override's name. Uses AppConfig key names.
 */
const ATOMIC_MERGE_PATHS = new Set<string>(['interfaceConfig.theme']);

/** AppConfig key → the override (YAML) section merged into it, the inverse of `OVERRIDE_KEY_MAP`. */
const OVERRIDE_SECTION_BY_APP_KEY = new Map<string, string>(
  Object.entries(OVERRIDE_KEY_MAP).flatMap(([section, appKey]) =>
    appKey ? [[appKey, section]] : [],
  ),
);

function toOverridePath(appConfigPath: string): string {
  const [first, ...rest] = appConfigPath.split('.');
  return [OVERRIDE_SECTION_BY_APP_KEY.get(first) ?? first, ...rest].join('.');
}

/** The merge rules in override (YAML) key names, for clients that plan writes the way they merge. */
export function getConfigMergeRules(): AdminConfigMergeRules {
  return {
    arrayMergeKeys: Object.fromEntries(
      Object.entries(ARRAY_MERGE_KEYS).map(([path, key]) => [toOverridePath(path), key]),
    ),
    atomicMergePaths: [...ATOMIC_MERGE_PATHS].map(toOverridePath),
    overrideKeyMap: Object.fromEntries(
      [...OVERRIDE_SECTION_BY_APP_KEY].map(([appKey, section]) => [section, appKey]),
    ),
    derivedPaths: [...DERIVED_CONFIG_PATHS],
  };
}

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

/**
 * `combineFoldedConfigItems` for the merged-by-key array at an override (YAML) path: stored
 * items naming one entry in two spellings, combined as the runtime merge combines them.
 */
export function combineFoldedConfigEntries(
  segments: readonly string[],
  items: unknown[],
): unknown[] {
  const arrayPath = getConfigMergeArrayPath(segments);
  return arrayPath === undefined ? items : combineFoldedConfigItems(arrayPath, items);
}

/**
 * `items` merged over `below` as the merge merges the merged-by-key array at an override (YAML)
 * path (`endpoints.custom` by `name`, `endpoints.azureOpenAI.groups` by `group`): matched items
 * deep-merged, others kept, new ones appended. At any other path, or over no array, `items`.
 */
export function mergeConfigEntries(
  segments: readonly string[],
  below: unknown,
  items: readonly unknown[],
): unknown[] {
  const arrayPath = getConfigMergeArrayPath(segments);
  if (arrayPath === undefined || !Array.isArray(below)) {
    return [...items];
  }
  return mergeArrayByKey(
    below,
    items as AnyObject[],
    ARRAY_MERGE_KEYS[arrayPath],
    segments.length - 1,
    arrayPath,
  );
}

function isBaseOnlyOverridePath(path: string): boolean {
  return BASE_ONLY_OVERRIDE_SECTIONS.has(path.split('.')[0]);
}

/**
 * Removes a path from `target`, stopping at arrays. A keyed path (`endpoints.custom["Name"]`)
 * reaches into an array merged by key instead: it removes every entry whose key has the same
 * identity (`Ollama` and `ollama` alike), or with a path inside the entry, that path from each
 * of them. Any other path holding `["` is split on its dots, as before keyed paths existed, so a
 * stored tombstone of a record key such as an MCP server named `a["b"]` keeps hiding it.
 */
function deletePath<T extends AnyObject>(target: T, path: string): T {
  const entry = isKeyedConfigPath(path) ? readConfigEntryTombstone(path) : null;
  if (entry) {
    return deleteEntryPath(target, entry);
  }
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

function deleteEntryPath<T extends AnyObject>(target: T, location: ConfigEntryLocation): T {
  const segments = [...location.segments];
  const items = getPath(target, segments);
  if (!Array.isArray(items) || !items.some((item) => isConfigEntryAt(location, item))) {
    return target;
  }
  const inside = location.entry.rest.join('.');
  const next =
    inside === ''
      ? items.filter((item) => !isConfigEntryAt(location, item))
      : items.map((item) =>
          isConfigEntryAt(location, item) ? deletePath(item as AnyObject, inside) : item,
        );
  return setPath(target, segments, next) as T;
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

/** The identity an item of the merged-by-key array at `arrayPath` matches on. */
function getMergeKey(item: AnyObject, keyField: string, arrayPath: string): unknown {
  const key = item[keyField];
  return typeof key === 'string' ? foldConfigMergeKey(arrayPath, key) : key;
}

/**
 * Combines the items of a stored merged-by-key array that name one item in more than one
 * spelling of its folded key (`Ollama` and `ollama`): merged in document order, later fields
 * winning, at the first one's position. A document stored before names were folded kept such
 * items apart, and the runtime took requests' `baseURL` and key from the first while serving
 * the later one's metadata, so the combined item keeps what each contributed instead of losing
 * the earlier one as a duplicate. A key repeated in only one spelling is left as is (the last
 * item applies). Returns the same array when nothing combines.
 */
export function combineFoldedConfigItems(arrayPath: string, items: unknown[]): unknown[] {
  const keyField = ARRAY_MERGE_KEYS[arrayPath];
  if (!keyField || !hasOwn(MERGE_KEY_FOLDS, arrayPath)) {
    return items;
  }
  const groups = new Map<string, { spellings: Set<string>; indexes: number[] }>();
  items.forEach((item, index) => {
    const key = isPlainObject(item) ? item[keyField] : undefined;
    if (typeof key !== 'string' || key === '') {
      return;
    }
    const identity = MERGE_KEY_FOLDS[arrayPath](key);
    const group = groups.get(identity) ?? { spellings: new Set<string>(), indexes: [] };
    group.spellings.add(key);
    group.indexes.push(index);
    groups.set(identity, group);
  });
  const depth = arrayPath.split('.').length;
  const combined = new Map<number, AnyObject>();
  const absorbed = new Set<number>();
  for (const { spellings, indexes } of groups.values()) {
    if (spellings.size < 2) {
      continue;
    }
    const [first, ...rest] = indexes;
    const merged = rest.reduce<AnyObject>(
      (item, index) => deepMerge(item, items[index] as AnyObject, depth, arrayPath),
      items[first] as AnyObject,
    );
    combined.set(first, merged);
    rest.forEach((index) => absorbed.add(index));
  }
  if (combined.size === 0) {
    return items;
  }
  return items.flatMap((item, index) => (absorbed.has(index) ? [] : [combined.get(index) ?? item]));
}

/** `combineFoldedConfigItems` over every folded array of a stored overrides document. */
function combineStoredFoldedItems(overrides: unknown, principal: string, quiet = false): unknown {
  let result = overrides;
  for (const arrayPath of Object.keys(MERGE_KEY_FOLDS)) {
    const segments = arrayPath.split('.');
    const items = getPath(result, segments);
    if (!Array.isArray(items)) {
      continue;
    }
    const combined = combineFoldedConfigItems(arrayPath, items);
    if (combined === items) {
      continue;
    }
    if (!quiet) {
      logger.warn(
        `[mergeConfigOverrides] Combining "${arrayPath}" items that name one entry in different spellings for ${principal}; a write of this list must name each entry once`,
      );
    }
    result = setPath(result, segments, combined);
  }
  return result;
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
      const key = getMergeKey(item, keyField, path);
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
  // nested ARRAY_MERGE_KEYS lookups. A matched item keeps the spelling of
  // its key the layer beneath gave it: an override `ollama` modifies the
  // YAML `Ollama`, which stays the entry's name.
  for (const item of target) {
    if (item != null && typeof item === 'object') {
      const key = getMergeKey(item, keyField, path);
      const override = key != null ? sourceByKey.get(key) : undefined;
      if (override) {
        result.push({ ...deepMerge(item, override, depth + 1, path), [keyField]: item[keyField] });
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
      !ATOMIC_MERGE_PATHS.has(currentPath) &&
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

export type ConfigOverrideIssue = {
  /** Dot-path of the override node the issue is attributed to, in YAML (`TCustomConfig`) keys. */
  path: string;
  /** The same location as keys, unambiguous when a record key itself contains a dot. */
  segments: string[];
  /**
   * A stable, machine-readable reason: a zod issue code (`invalid_type`, `custom`, ...),
   * `unknown_section`, `missing_merge_key`, `duplicate_merge_key`, `indexed_merge_key_write`,
   * `union_dropped_key`, `dotted_key`, or `invalid_document`. Schema messages are not carried
   * because they can echo the submitted values.
   */
  code: string;
  /**
   * What the schema expected, for a zod issue attributed to the exact node that failed
   * (`getConfigIssueParams`); absent when the issue is reported on an ancestor the override
   * supplies, where the bound would describe a node the override did not write.
   */
  params?: ConfigIssueParams;
};

type IssuePath = Array<string | number>;

function isPlainObject(value: unknown): value is AnyObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * Whether `key` is a top-level section an override may hold: one `configSchema` defines.
 * Anything else names runtime state the merge would otherwise reach (`paths`, the raw-YAML
 * `config`, the AppService aliases `interfaceConfig`/`mcpConfig`/`turnstileConfig`), so it is
 * rejected on write and ignored at merge. Unknown keys inside a known section stay accepted.
 */
export function isAcceptedOverrideSection(key: string): boolean {
  return hasOwn(configSchema.shape, key);
}

function toIssue(
  segments: string[],
  code: string,
  params?: ConfigIssueParams,
): ConfigOverrideIssue {
  return params
    ? { path: segments.join('.'), segments, code, params }
    : { path: segments.join('.'), segments, code };
}

type IssuePrimitive = string | number | boolean | null;

const CUSTOM_REASON = /^[a-z][a-z0-9_]*$/;

function isIssuePrimitive(value: unknown): value is IssuePrimitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** A numeric bound as JSON can carry it: a date as epoch milliseconds, never a bigint. */
function toIssueNumber(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The bound fields of a `too_small` or `too_big` issue, always with `inclusive`, `exact`, `type`. */
function getBoundParams(
  bound: 'minimum' | 'maximum',
  value: unknown,
  issue: { inclusive?: boolean; exact?: boolean; origin: string },
): ConfigIssueParams {
  const number = toIssueNumber(value);
  return {
    ...(number !== undefined && { [bound]: number }),
    inclusive: issue.inclusive ?? false,
    exact: issue.exact ?? false,
    type: issue.origin,
  };
}

/** Expected-type names that the reported contract spells differently from zod. */
const EXPECTED_TYPE_NAMES: Record<string, string> = {
  int: 'integer',
  record: 'object',
  tuple: 'array',
};

/** String-format names that the reported contract spells as the check that failed. */
const STRING_FORMAT_NAMES: Record<string, string> = {
  starts_with: 'startsWith',
  ends_with: 'endsWith',
};

/** The kind of the submitted value, by name only, so the value itself is never reported. */
function getReceivedType(input: unknown, expected: string): string {
  if (input === null) {
    return 'null';
  }
  if (Array.isArray(input)) {
    return 'array';
  }
  if (input instanceof Date) {
    return 'date';
  }
  if (input instanceof Map) {
    return 'map';
  }
  if (input instanceof Set) {
    return 'set';
  }
  if (typeof input !== 'number') {
    return typeof input;
  }
  if (Number.isNaN(input)) {
    return 'nan';
  }
  return expected === 'int' && !Number.isInteger(input) ? 'float' : 'number';
}

/** Whether a union issue is the discriminator mismatch of a discriminated union. */
function isDiscriminatorIssue(issue: SchemaIssue): issue is SchemaIssue & { options: unknown[] } {
  return (
    issue.code === 'invalid_union' &&
    issue.discriminator != null &&
    Array.isArray((issue as { options?: unknown }).options)
  );
}

/**
 * The stable code an issue is reported under. Codes keep the names the override contract was
 * published with, so a zod release that renames its issue codes does not change the response.
 */
export function getConfigIssueCode(issue: SchemaIssue): string {
  if (issue.code === 'invalid_value') {
    return issue.values.length === 1 ? 'invalid_literal' : 'invalid_enum_value';
  }
  if (issue.code === 'invalid_format') {
    return 'invalid_string';
  }
  return isDiscriminatorIssue(issue) ? 'invalid_union_discriminator' : issue.code;
}

/**
 * The parts of a zod issue that describe the schema rather than the submitted value, by an
 * allowlist per issue code: expected types and literals, accepted options, numeric bounds, the
 * failed string check, a multiple, and a refinement's stable `reason`. A value the client sent
 * is never copied (only the name of its type, no literal or enum value, no message), so the
 * result is safe to return. `undefined` when the issue carries none of these.
 */
export function getConfigIssueParams(issue: SchemaIssue): ConfigIssueParams | undefined {
  let params: ConfigIssueParams | undefined;
  switch (issue.code) {
    case 'invalid_type':
      params = {
        expected: EXPECTED_TYPE_NAMES[issue.expected] ?? issue.expected,
        ...('input' in issue && { received: getReceivedType(issue.input, issue.expected) }),
      };
      break;
    case 'invalid_value': {
      const [expected] = issue.values;
      if (issue.values.length > 1) {
        params = { options: issue.values.filter(isIssuePrimitive) };
      } else {
        params = isIssuePrimitive(expected) ? { expected } : undefined;
      }
      break;
    }
    case 'invalid_union':
      params = isDiscriminatorIssue(issue)
        ? { options: issue.options.filter(isIssuePrimitive) }
        : undefined;
      break;
    case 'too_small':
      params = getBoundParams('minimum', issue.minimum, issue);
      break;
    case 'too_big':
      params = getBoundParams('maximum', issue.maximum, issue);
      break;
    case 'invalid_format':
      params = { validation: STRING_FORMAT_NAMES[issue.format] ?? issue.format };
      break;
    case 'not_multiple_of': {
      const multipleOf = toIssueNumber(issue.divisor);
      params = multipleOf !== undefined ? { multipleOf } : undefined;
      break;
    }
    case 'custom': {
      const reason: unknown = issue.params?.reason;
      params = typeof reason === 'string' && CUSTOM_REASON.test(reason) ? { reason } : undefined;
      break;
    }
    default:
      params = undefined;
  }
  return params && Object.keys(params).length > 0 ? params : undefined;
}

/**
 * The override item an issue path segment names: by the merge key for merged-by-key arrays
 * (the merged index differs from the override's; the last item with a key is the one merged), by index, or by `id` for refinements that
 * address an item by its identifier.
 */
function findItemIndex(
  node: unknown[],
  key: string,
  keyField: string | undefined,
  mergedItem: unknown,
  arrayPath: string,
): number {
  if (keyField) {
    if (!isPlainObject(mergedItem)) {
      return -1;
    }
    const mergedKey = getMergeKey(mergedItem, keyField, arrayPath);
    for (let index = node.length - 1; index >= 0; index--) {
      const item = node[index];
      if (isPlainObject(item) && getMergeKey(item, keyField, arrayPath) === mergedKey) {
        return index;
      }
    }
    return -1;
  }
  if (/^\d+$/.test(key)) {
    return Number(key);
  }
  return node.findIndex((item) => isPlainObject(item) && item.id === key);
}

/**
 * The override node an issue in the merged config belongs to: the deepest node the
 * overrides supply on the issue's path. Items of merged-by-key arrays are matched by their
 * key, since the merged index differs from the override's. `undefined` means the overrides
 * did not supply anything on the path, so the issue is the base's own.
 */
function attributeIssue(
  overrides: AnyObject,
  merged: AnyObject,
  issuePath: IssuePath,
): string[] | undefined {
  const segments: string[] = [];
  let node: unknown = overrides;
  let mergedNode: unknown = merged;
  for (const part of issuePath) {
    const key = String(part);
    if (Array.isArray(node)) {
      const arrayPath = segments.join('.');
      const keyField = hasOwn(ARRAY_MERGE_KEYS, arrayPath)
        ? ARRAY_MERGE_KEYS[arrayPath]
        : undefined;
      const mergedItem = Array.isArray(mergedNode) ? mergedNode[Number(key)] : undefined;
      const index = findItemIndex(node, key, keyField, mergedItem, arrayPath);
      if (keyField && index < 0) {
        return undefined;
      }
      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        break;
      }
      segments.push(String(index));
      node = node[index];
      mergedNode = Array.isArray(mergedNode)
        ? mergedNode[keyField ? Number(key) : index]
        : undefined;
      continue;
    }
    if (!isPlainObject(node) || !hasOwn(node, key)) {
      break;
    }
    segments.push(key);
    node = node[key];
    mergedNode = isPlainObject(mergedNode) ? mergedNode[key] : undefined;
  }
  return segments.length > 0 ? segments : undefined;
}

/**
 * Whether the override node at `segments` is final: at or inside an array the merge replaces
 * (any array not merged by key), so no other layer can supply what it leaves out.
 */
function isReplacedArrayNode(overrides: AnyObject, segments: string[]): boolean {
  let node: unknown = overrides;
  for (let index = 0; index < segments.length; index++) {
    node = Array.isArray(node)
      ? node[Number(segments[index])]
      : (node as AnyObject)[segments[index]];
    const path = segments.slice(0, index + 1).join('.');
    if (Array.isArray(node) && !hasOwn(ARRAY_MERGE_KEYS, path)) {
      return true;
    }
  }
  return false;
}

/**
 * Items of a merged-by-key array must be objects with their own key: the merge drops any
 * other item (or keeps it as is when nothing lies beneath the array). A repeated key is
 * reported on the earlier items: the last one is what the merge keeps.
 */
function getMergeKeyIssues(overrides: AnyObject): ConfigOverrideIssue[] {
  return Object.entries(ARRAY_MERGE_KEYS).flatMap(([arrayPath, keyField]) => {
    const segments = arrayPath.split('.');
    let node: unknown = overrides;
    for (const segment of segments) {
      node = isPlainObject(node) && hasOwn(node, segment) ? node[segment] : undefined;
    }
    if (!Array.isArray(node)) {
      return [];
    }
    const lastIndex = new Map<unknown, number>();
    node.forEach(
      (item, index) =>
        isPlainObject(item) && lastIndex.set(getMergeKey(item, keyField, arrayPath), index),
    );
    return node.flatMap((item, index) => {
      if (!isPlainObject(item) || typeof item[keyField] !== 'string' || item[keyField] === '') {
        return [toIssue([...segments, String(index)], 'missing_merge_key')];
      }
      return lastIndex.get(getMergeKey(item, keyField, arrayPath)) === index
        ? []
        : [toIssue([...segments, String(index)], 'duplicate_merge_key')];
    });
  });
}

type SchemaIssue = NonNullable<
  ReturnType<typeof configSchema.safeParse>['error']
>['issues'][number];

/** A zod issue path as an override path; config keys are never symbols. */
function toIssuePath(path: readonly PropertyKey[]): IssuePath {
  return path.filter((segment): segment is string | number => typeof segment !== 'symbol');
}

/**
 * Unwrap record-key failures and select the closest union branch by issue count, then depth.
 * Nested issues have relative paths, so each wrapper's path is prepended before recursing.
 */
function expandSchemaIssues(issues: SchemaIssue[], depth = 0): SchemaIssue[] {
  return issues.flatMap((issue) => {
    if (depth >= MAX_MERGE_DEPTH) {
      return [issue];
    }
    if (issue.code === 'invalid_key') {
      return expandSchemaIssues(
        issue.issues.map((keyIssue) => ({
          ...keyIssue,
          path: [...issue.path, ...keyIssue.path],
        })),
        depth + 1,
      );
    }
    if (issue.code !== 'invalid_union') {
      return [issue];
    }
    const branches = (issue.errors as SchemaIssue[][]).map((branch) =>
      branch.map((branchIssue) => ({ ...branchIssue, path: [...issue.path, ...branchIssue.path] })),
    );
    const closest = branches.reduce<SchemaIssue[] | undefined>((best, branch) => {
      if (!best || branch.length < best.length) {
        return branch;
      }
      const depthOf = (list: SchemaIssue[]) => Math.max(0, ...list.map((i) => i.path.length));
      return branch.length === best.length && depthOf(branch) > depthOf(best) ? branch : best;
    }, undefined);
    return closest && closest.length > 0 ? expandSchemaIssues(closest, depth + 1) : [issue];
  });
}

/** The parts of a zod schema the shape walk reads, without depending on zod. */
type SchemaNode = {
  def: {
    type: string;
    innerType?: SchemaNode;
    in?: SchemaNode;
    out?: SchemaNode;
    getter?: () => SchemaNode;
    element?: SchemaNode;
    valueType?: SchemaNode;
    left?: SchemaNode;
    right?: SchemaNode;
    options?: SchemaNode[];
  };
  shape?: Record<string, SchemaNode>;
  safeParse: (value: unknown) => { success: boolean };
};

/** The side of a pipe that validates the value: the input, unless it only preprocesses. */
function getPipeSchema(node: SchemaNode): SchemaNode | undefined {
  const { in: input, out } = node.def;
  return input?.def.type === 'transform' ? out : input;
}

/** The schema beneath optional, nullable, default, transform, preprocess and lazy wrappers. */
function unwrapSchema(schema: SchemaNode): SchemaNode {
  let node = schema;
  for (let depth = 0; depth < MAX_MERGE_DEPTH; depth++) {
    const inner =
      node.def.innerType ??
      (node.def.type === 'pipe' ? getPipeSchema(node) : undefined) ??
      node.def.getter?.();
    if (!inner) {
      break;
    }
    node = inner;
  }
  return node;
}

/** The schema one segment below `node`, through objects, records, arrays and union options. */
function getChildSchema(node: SchemaNode, segment: string, depth = 0): SchemaNode | undefined {
  const inner = unwrapSchema(node);
  const { type } = inner.def;
  if (type === 'object' && inner.shape) {
    return hasOwn(inner.shape, segment) ? inner.shape[segment] : undefined;
  }
  if (type === 'record') {
    return inner.def.valueType;
  }
  if (type === 'array') {
    return ARRAY_INDEX.test(segment) ? inner.def.element : undefined;
  }
  if (type === 'union' && inner.def.options && depth < MAX_MERGE_DEPTH) {
    for (const option of inner.def.options.values()) {
      const child = getChildSchema(option, segment, depth + 1);
      if (child) {
        return child;
      }
    }
  }
  return undefined;
}

/** Whether {@link getChildSchema} reaches `segment` below `node` through an array. */
function isArrayStep(node: SchemaNode, segment: string, depth = 0): boolean {
  const inner = unwrapSchema(node);
  const { type } = inner.def;
  if (type === 'array') {
    return true;
  }
  if (type !== 'union' || !inner.def.options || depth >= MAX_MERGE_DEPTH) {
    return false;
  }
  for (const option of inner.def.options.values()) {
    if (getChildSchema(option, segment, depth + 1)) {
      return isArrayStep(option, segment, depth + 1);
    }
  }
  return false;
}

/**
 * The `configSchema` node an override (YAML) path names (`undefined` when the schema does not
 * define it), and whether the path continues past an array on the way. Below a field of a
 * known section that the schema does not define (a key it does not know, or what an
 * intersection or `any` holds), the stored value decides the shape, so an index segment there
 * is taken to name an array element. Only steps from index `from` of `segments` on count toward
 * `throughArray`, so a path inside an array entry can be judged on the entry's own arrays.
 */
function resolveConfigSchemaPath(
  segments: readonly string[],
  from = 0,
): {
  node?: SchemaNode;
  throughArray: boolean;
} {
  const [section, ...rest] = segments;
  const shape = configSchema.shape as unknown as Record<string, SchemaNode>;
  if (section === undefined || !hasOwn(shape, section)) {
    return { throughArray: false };
  }
  let node: SchemaNode | undefined = shape[section];
  let throughArray = false;
  for (let index = 0; index < rest.length; index++) {
    const segment = rest[index];
    /** `from` counts in `segments`, where `rest[index]` is `segments[index + 1]`. */
    const counts = index + 1 >= from;
    if (!node || OPAQUE_SCHEMA_TYPES.has(unwrapSchema(node).def.type)) {
      node = undefined;
      throughArray = throughArray || (counts && ARRAY_INDEX.test(segment));
      continue;
    }
    throughArray = throughArray || (counts && isArrayStep(node, segment));
    node = getChildSchema(node, segment);
  }
  return { node, throughArray };
}

/**
 * Whether an override (YAML) path names a record in `configSchema`: an object whose keys are
 * names the operator chooses (`mcpServers`, a `headers` map, `inferenceProfiles`), so one key
 * can be renamed to another without changing what the value means. Fixed-shape objects are not
 * records.
 */
export function isConfigRecordPath(segments: readonly string[]): boolean {
  const { node } = resolveConfigSchemaPath(segments);
  return node != null && unwrapSchema(node).def.type === 'record';
}

/**
 * Whether an override (YAML) path continues past an array of `configSchema`, or may: it names
 * an element of the array or a path inside one, or has an index segment below a field of a
 * known section the schema does not define. A tombstone there hides nothing, because the merge
 * removes inherited values from objects only (a whole array can be hidden).
 */
export function isConfigArrayItemPath(segments: readonly string[]): boolean {
  return resolveConfigSchemaPath(segments).throughArray;
}

/**
 * {@link isConfigArrayItemPath} for a path inside an entry of the merged-by-key array at
 * `segments`: whether `rest` continues past an array of the entry's own schema (`models.default.0`),
 * which a keyed tombstone cannot hide part of either.
 */
export function isConfigEntryArrayItemPath(
  segments: readonly string[],
  rest: readonly string[],
): boolean {
  return resolveConfigSchemaPath([...segments, '0', ...rest], segments.length + 1).throughArray;
}

/**
 * The combined fixed shape of an intersection of objects (`a.and(b)`), or `undefined` when a
 * side is not an object, so nothing is judged on a shape the walk cannot see whole.
 */
function getIntersectionShape(node: SchemaNode, depth = 0): Record<string, SchemaNode> | undefined {
  if (depth >= MAX_MERGE_DEPTH || !node.def.left || !node.def.right) {
    return undefined;
  }
  const [left, right] = [node.def.left, node.def.right].map((side) => {
    const inner = unwrapSchema(side);
    return inner.def.type === 'intersection' ? getIntersectionShape(inner, depth + 1) : inner.shape;
  });
  return left && right ? { ...left, ...right } : undefined;
}

/** Whether a schema accepts arbitrary keys at this level (a record, or a union with one). */
function isRecordSchema(schema: SchemaNode): boolean {
  const node = unwrapSchema(schema);
  const { type, options } = node.def;
  if (type === 'record') {
    return true;
  }
  return type === 'union' && options != null && [...options.values()].some(isRecordSchema);
}

type ShapeIssue = { code: 'union_dropped_key' | 'dotted_key'; path: IssuePath };

function toDottedKeyIssues(value: AnyObject, path: IssuePath): ShapeIssue[] {
  return Object.keys(value)
    .filter((key) => key.includes('.'))
    .map((key): ShapeIssue => ({ code: 'dotted_key', path: [...path, key] }));
}

/**
 * The walk of an object with a fixed shape: a key holding a dot can only be a mistaken
 * path (`{ 'webSearch.serperApiKey': ... }`), which the schema strips as unknown and the secret
 * registry never sees, so it is reported instead of stored as an inert literal key.
 */
function findObjectShapeIssues(
  shape: Record<string, SchemaNode>,
  value: AnyObject,
  path: IssuePath,
  depth: number,
): ShapeIssue[] {
  return Object.keys(value).flatMap((key): ShapeIssue[] => {
    if (key.includes('.')) {
      return [{ code: 'dotted_key', path: [...path, key] }];
    }
    return hasOwn(shape, key)
      ? findShapeIssues(shape[key], value[key], [...path, key], depth + 1)
      : [];
  });
}

/**
 * What a schema walk finds that parsing does not report:
 * - `union_dropped_key`: an object parses with the first union option that accepts it, and
 *   that option strips keys it does not define, so a key another option defines (and would
 *   type-check) is kept raw in the stored override but never validated.
 * - `dotted_key`: a key holding a dot where the schema has a fixed shape. Dots are only
 *   meaningful in record keys (model names such as `gpt-4.1`, Bedrock inference profiles, MIME
 *   types, header names), which a record keeps as one segment.
 *
 * Keys no schema node defines are unknown keys and stay accepted.
 */
function findShapeIssues(
  schema: SchemaNode,
  value: unknown,
  path: IssuePath,
  depth = 0,
): ShapeIssue[] {
  if (depth >= MAX_MERGE_DEPTH) {
    return [];
  }
  const node = unwrapSchema(schema);
  const { type } = node.def;
  if (type === 'object' && node.shape && isPlainObject(value)) {
    return findObjectShapeIssues(node.shape, value, path, depth);
  }
  if (type === 'intersection' && isPlainObject(value)) {
    const shape = getIntersectionShape(node);
    return shape ? findObjectShapeIssues(shape, value, path, depth) : [];
  }
  if (type === 'array' && node.def.element && Array.isArray(value)) {
    const item = node.def.element;
    return value.flatMap((entry, index) =>
      findShapeIssues(item, entry, [...path, index], depth + 1),
    );
  }
  if (type === 'record' && node.def.valueType && isPlainObject(value)) {
    const entrySchema = node.def.valueType;
    return Object.entries(value).flatMap(([key, entry]) =>
      findShapeIssues(entrySchema, entry, [...path, key], depth + 1),
    );
  }
  if (type !== 'union' || !node.def.options || !isPlainObject(value)) {
    return [];
  }
  const options = [...node.def.options.values()];
  const accepted = options.find((option) => option.safeParse(value).success);
  if (!accepted) {
    /** A strict option fails on the dotted key itself, and parsing reports it only as unrecognized. */
    return isRecordSchema(node) ? [] : toDottedKeyIssues(value, path);
  }
  const acceptedShape = unwrapSchema(accepted).shape;
  const defined = new Set(
    options.flatMap((option) => Object.keys(unwrapSchema(option).shape ?? {})),
  );
  const dropped: ShapeIssue[] = acceptedShape
    ? Object.keys(value)
        .filter((key) => !hasOwn(acceptedShape, key) && defined.has(key))
        .map((key): ShapeIssue => ({ code: 'union_dropped_key', path: [...path, key] }))
    : [];
  return [...dropped, ...findShapeIssues(accepted, value, path, depth + 1)];
}

/**
 * Top-level override keys are section names, never paths: a dotted one would be stored as an
 * inert literal key, outside the secret registry and every per-section rule.
 */
export function getDottedSectionIssues(overrides: unknown): ConfigOverrideIssue[] {
  if (!isPlainObject(overrides)) {
    return [];
  }
  return Object.keys(overrides)
    .filter((key) => key.includes('.'))
    .map((key) => toIssue([key], 'dotted_key'));
}

/**
 * Checks config overrides the way they apply: merged over `base` (YAML-shaped), each
 * section they touch parsed with its `configSchema` schema, and every failure attributed
 * to the override node that caused it. Unions, refinements, required fields and defaults
 * are therefore judged on the merged result, not on the patch alone. An issue caused only
 * by leaving something out (a required or related field another layer may supply) is not
 * reported, except inside an array the merge replaces, where nothing can supply it. A top-level
 * key that is not a `configSchema` section is reported as `unknown_section` (or as `dotted_key`
 * alone when it holds a dot); keys the schema does not define inside a known section are
 * accepted unchanged, and a key holding a dot is a `dotted_key` issue unless it sits where the
 * schema has a record. Sections that pass their schema are also checked for what AppService
 * derives from them (`getDerivedConfigIssues`): Azure groups that do not resolve, a Vertex AI
 * setup that does not load, custom endpoint parameter definitions (with
 * `derivation.expandCustomEndpoint`) and model spec endpoints.
 */
export function getConfigOverrideIssues(
  overrides: unknown,
  base: Partial<TCustomConfig> = {},
  derivation: ConfigDerivation = {},
): ConfigOverrideIssue[] {
  if (!isPlainObject(overrides)) {
    return [toIssue([], 'invalid_document')];
  }
  const merged = deepMerge(base as AnyObject, overrides);
  const issues = [...getDottedSectionIssues(overrides), ...getMergeKeyIssues(overrides)];
  const seen = new Set(issues.map((issue) => issue.path));
  const report = (issuePath: IssuePath, code: string, schemaIssue?: SchemaIssue) => {
    const segments = attributeIssue(overrides, merged, issuePath);
    if (
      !segments ||
      (segments.length < issuePath.length && !isReplacedArrayNode(overrides, segments))
    ) {
      return;
    }
    const path = segments.join('.');
    if (seen.has(path)) {
      return;
    }
    seen.add(path);
    const exact = schemaIssue != null && segments.length === issuePath.length;
    issues.push(toIssue(segments, code, exact ? getConfigIssueParams(schemaIssue) : undefined));
  };
  const shape = configSchema.shape;
  const validSections = new Set<string>();
  for (const section of Object.keys(overrides)) {
    if (!hasOwn(shape, section)) {
      if (!seen.has(section)) {
        issues.push(toIssue([section], 'unknown_section'));
      }
      continue;
    }
    const schema = shape[section as keyof typeof shape] as unknown as SchemaNode;
    const result = shape[section as keyof typeof shape].safeParse(merged[section], {
      reportInput: true,
    });
    const shapeIssues = findShapeIssues(schema, merged[section], []);
    const schemaIssues = result.success ? [] : expandSchemaIssues(result.error.issues);
    if (result.success && shapeIssues.length === 0) {
      validSections.add(section);
    }
    for (const issue of shapeIssues) {
      report([section, ...issue.path], issue.code);
    }
    for (const issue of schemaIssues) {
      if (issue.code !== 'unrecognized_keys') {
        report([section, ...toIssuePath(issue.path)], getConfigIssueCode(issue), issue);
      }
    }
  }
  /** A derived check that fails over a value the schema already faulted adds nothing to that issue. */
  const faulted = issues.map((issue) => issue.segments);
  for (const { path, code } of getDerivedConfigIssues(
    overrides,
    merged,
    validSections,
    derivation,
  )) {
    if (!faulted.some((segments) => isSegmentPrefix(path, segments))) {
      report(path, code);
    }
  }
  return issues;
}

/** Sets a path without mutating, replacing whatever is in the way. */
function setPath(target: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) {
    return value;
  }
  const [segment, ...rest] = segments;
  if (Array.isArray(target) && /^\d+$/.test(segment)) {
    const next = [...target];
    next[Number(segment)] = setPath(next[Number(segment)], rest, value);
    return next;
  }
  const next: AnyObject = isPlainObject(target) ? { ...target } : {};
  next[segment] = setPath(next[segment], rest, value);
  return next;
}

function isRelatedPath(a: string[], b: string[]): boolean {
  const length = Math.min(a.length, b.length);
  return a.slice(0, length).every((segment, index) => segment === b[index]);
}

/**
 * The base a principal's override lands on: `base` without the paths the principal
 * tombstones, except those in `cleared` (tombstones the pending write removes).
 */
export function applyConfigTombstones(
  base: Partial<TCustomConfig>,
  tombstones: unknown[] | undefined,
  cleared: Set<string> = new Set(),
): Partial<TCustomConfig> {
  return (tombstones ?? [])
    .filter((path): path is string => typeof path === 'string' && !cleared.has(path))
    .flatMap((path) => getTombstoneRemovals(path, true))
    .reduce((current, path) => deletePath(current, path), base as AnyObject);
}

/**
 * An item of a merged-by-key array is identified by its key, not its position: a write by index
 * can rename the stored item, which the runtime merge then treats as a new one. Reports the
 * array once for any write that addresses inside it by position.
 */
export function getIndexedMergeKeyIssues(
  written: ReadonlyArray<readonly string[]>,
): ConfigOverrideIssue[] {
  return Object.keys(ARRAY_MERGE_KEYS).flatMap((arrayPath) => {
    const arraySegments = arrayPath.split('.');
    return written.some(
      (segments) =>
        segments.length > arraySegments.length && isRelatedPath([...segments], arraySegments),
    )
      ? [toIssue(arraySegments, 'indexed_merge_key_write')]
      : [];
  });
}

function hasMergeKey(item: unknown, keyField: string): boolean {
  return isPlainObject(item) && typeof item[keyField] === 'string' && item[keyField] !== '';
}

/**
 * Where an issue sits in `overrides`, in a form that survives entries moving: an item of a
 * merged-by-key array is named by its key's identity (`getConfigEntryIdentity`), or (without
 * one) by its place among the keyless items, rather than by its index. Removing one entry
 * shifts the ones after it, and their issues must still match the ones the stored document
 * already had.
 */
function getIssueLocation(segments: readonly string[], overrides: unknown): string {
  const location: Array<string | { key: unknown } | { keyless: number }> = [];
  let node: unknown = overrides;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const keyField = Array.isArray(node)
      ? getConfigArrayMergeKey(segments.slice(0, index))
      : undefined;
    if (Array.isArray(node) && keyField) {
      const position = Number(segment);
      const item: unknown = node[position];
      location.push(
        hasMergeKey(item, keyField)
          ? {
              key: getConfigEntryIdentity(
                segments.slice(0, index),
                (item as AnyObject)[keyField] as string,
              ),
            }
          : {
              keyless: node.slice(0, position).filter((other) => !hasMergeKey(other, keyField))
                .length,
            },
      );
      node = item;
      continue;
    }
    location.push(segment);
    if (Array.isArray(node)) {
      node = node[Number(segment)];
    } else {
      node = isPlainObject(node) && hasOwn(node, segment) ? node[segment] : undefined;
    }
  }
  return JSON.stringify(location);
}

/**
 * Checks a principal's next override document in its final state: `candidate` merged over
 * `base` without the candidate's tombstones, so a batch that tombstones a field and sets its
 * replacement is judged on the end result rather than step by step. An issue is reported when
 * it touches a `written` path (in either direction), or when the change introduced it
 * elsewhere (a related field the change made invalid); issues the stored document already had
 * (at the same location, entries of merged-by-key arrays matched by key) are left to merge
 * time so they do not block an unrelated change.
 *
 * A derived issue the merge copes with on its own (`WRITE_ONLY_DERIVED_ISSUES`: a model spec
 * whose endpoint is not configured, which the merge leaves out) is reported only where the change
 * writes, never as one it introduced elsewhere: hiding or removing the endpoint a stored spec
 * selects takes the spec with it, as the single-field routes let it.
 *
 * The stored document is judged on the base its own tombstones leave, so an issue that a
 * removed tombstone brings back counts as new. `lifted` names stored tombstones to treat as
 * already removed there: tombstones the change replaced with values of its own.
 */
export function getConfigChangeIssues(
  candidate: { overrides?: unknown; tombstones?: unknown[] },
  base: Partial<TCustomConfig>,
  stored: { overrides?: unknown; tombstones?: unknown[] } | null | undefined,
  written: ReadonlyArray<readonly string[]>,
  lifted: Iterable<string> = [],
  derivation: ConfigDerivation = {},
): ConfigOverrideIssue[] {
  const candidateState = toConfigOverrideState(candidate);
  const storedState = toConfigOverrideState(stored);
  const existing = new Set(
    getConfigOverrideIssues(
      storedState.overrides,
      applyConfigTombstones(base, storedState.tombstones, new Set(lifted)),
      derivation,
    ).map((issue) => getIssueLocation(issue.segments, storedState.overrides)),
  );
  return getConfigOverrideIssues(
    candidateState.overrides,
    applyConfigTombstones(base, candidateState.tombstones),
    derivation,
  ).filter((issue) => {
    const touched = written.some((segments) => isRelatedPath(issue.segments, [...segments]));
    if (touched || WRITE_ONLY_DERIVED_ISSUES.has(issue.code)) {
      return touched;
    }
    return !existing.has(getIssueLocation(issue.segments, candidateState.overrides));
  });
}

/**
 * Checks field writes on top of the principal's stored config, building the result with the
 * same transform the write stores (`setConfigFields`): each path set in order, and the
 * tombstones those paths clear removed. `fields` is either a map of dotted field paths or a
 * list of segment writes (which can address keys that contain dots). A path the stored
 * document cannot take (below a scalar, or a named key of an array) throws a
 * `ConfigPathError`. See {@link getConfigChangeIssues} for which issues are reported.
 *
 * A tombstone a write replaces with its own value counts as lifted for the stored document
 * too, so a client that sends one field per request can switch a union's shape (set the new
 * field, then reset the old ones). A tombstone a deeper write clears as a side effect does
 * not: setting `memory.agent.enabled` under a hidden `memory.agent` brings the inherited agent
 * back, and a conflict with the stored fields is reported instead of being dropped at merge.
 * Nor does a keyed tombstone, which a write never clears by its spelled path
 * (`getPathClearedTombstones`): a segment `custom["Name"]` is a key of that spelling.
 *
 * `renames` are the entry renames the write carries out (a `renames` hint), which move the keyed
 * tombstones of each old entry key to its new one (`renameConfigEntryTombstones`).
 */
export function getConfigFieldIssues(
  fields: Record<string, unknown> | readonly ConfigFieldWrite[],
  base: Partial<TCustomConfig> = {},
  stored?: { overrides?: unknown; tombstones?: unknown[] } | null,
  renames: readonly ConfigEntryRename[] = [],
  derivation: ConfigDerivation = {},
): ConfigOverrideIssue[] {
  const writes: readonly ConfigFieldWrite[] = Array.isArray(fields)
    ? fields
    : Object.entries(fields).map(([fieldPath, value]) => ({
        segments: parseFieldPath(fieldPath),
        value,
      }));
  const written = writes.map(({ segments }) => [...segments]);
  const indexed = getIndexedMergeKeyIssues(written);
  if (indexed.length > 0) {
    return indexed;
  }
  const candidate = renameConfigEntriesTombstones(
    setConfigFields(toConfigOverrideState(stored), writes),
    renames,
  );
  return getConfigChangeIssues(
    candidate,
    base,
    stored,
    written,
    getLiftedConfigTombstones(written),
    derivation,
  );
}

/**
 * The stored tombstones writes at `written` replace with their own values, as
 * {@link getConfigFieldIssues} lifts them: each dot-free path, unless its spelling reads as a
 * keyed tombstone, which a write never clears by its spelled path.
 */
export function getLiftedConfigTombstones(written: readonly (readonly string[])[]): string[] {
  return written.flatMap((segments) => {
    const path = segments.join('.');
    return isDotFreePath(segments) && readConfigEntryTombstone(path) == null ? [path] : [];
  });
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
  if (!isPlainObject(target) || !hasOwn(target, segment)) {
    return target;
  }
  const next = { ...target };
  const child = rest.length === 0 ? undefined : omitPath(next[segment], rest);
  /** A node its repairs emptied supplies nothing, so the value beneath it stays instead. */
  const emptied = child != null && typeof child === 'object' && Object.keys(child).length === 0;
  if (rest.length === 0 || emptied) {
    delete next[segment];
  } else {
    next[segment] = child;
  }
  return next;
}

/**
 * Drops the override nodes that make the merged config fail `configSchema`, so an invalid
 * stored value (written before write-time validation, by an older server, or one that only
 * fails once layered over other overrides) leaves the value beneath it in place. A layer
 * is not judged on what it leaves out, since a layer that merges after it may supply it.
 */
function stripInvalidOverrides(
  config: ConfigOverrideLayer,
  base: Partial<TCustomConfig>,
  derivation: ConfigDerivation,
  sink?: LayerIgnoredSink,
  onStripped?: (issue: ConfigOverrideIssue) => void,
): AnyObject {
  const principal = `${config.principalType}/${config.principalId}`;
  let stripped: unknown = combineStoredFoldedItems(config.overrides, principal, sink != null);
  const getIssues = () =>
    getConfigOverrideIssues(stripped, base, derivation).filter(
      (issue) => !WRITE_ONLY_DERIVED_ISSUES.has(issue.code),
    );
  /**
   * Removing a field can make a related field it supplies fail, so check again while
   * removals make progress. If they stop, only the sections that still fail are dropped.
   */
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const issues = getIssues();
    if (issues.length === 0) {
      return stripped as AnyObject;
    }
    if (issues.some((issue) => issue.segments.length === 0)) {
      if (sink) {
        sink(toIgnored([], 'invalid', 'override'));
      } else {
        logger.warn(
          `[mergeConfigOverrides] Ignoring malformed overrides document for ${principal}`,
        );
      }
      onStripped?.(toIssue([], issues.find((issue) => issue.segments.length === 0)?.code ?? ''));
      return {};
    }
    const before = stripped;
    for (let index = issues.length - 1; index >= 0; index--) {
      const { path, segments, code } = issues[index];
      if (sink) {
        sink(toIgnored(segments, 'invalid', 'override'));
      } else {
        logger.warn(
          `[mergeConfigOverrides] Ignoring invalid override "${path}" for ${principal} (${code})`,
        );
      }
      stripped = omitPath(stripped, segments);
      onStripped?.(issues[index]);
    }
    if (stripped === before) {
      break;
    }
  }
  const failing = new Map<string, string>();
  for (const issue of getIssues()) {
    if (!failing.has(issue.segments[0])) {
      failing.set(issue.segments[0], issue.code);
    }
  }
  if (sink) {
    failing.forEach((_code, section) => sink(toIgnored([section], 'invalid', 'override')));
  } else {
    logger.warn(
      `[mergeConfigOverrides] Ignoring still-invalid sections ${[...failing.keys()].join(', ')} for ${principal}`,
    );
  }
  for (const [section, code] of failing) {
    onStripped?.(toIssue([section], code));
  }
  return Object.fromEntries(
    Object.entries(stripped as AnyObject).filter(([section]) => !failing.has(section)),
  );
}

/**
 * A layer's `mcpServers` without the servers `current` (the merged MCP config below it) runs as
 * a local process, or that the override would turn into one; `onDropped` is told each name.
 */
function filterMCPServerOverrides(
  value: unknown,
  current: unknown,
  onDropped?: (serverName: string) => void,
): AnyObject {
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
      } else {
        onDropped?.(serverName);
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
    } else {
      onDropped?.(serverName);
    }
  }

  return filtered;
}

/** One layer's step through {@link mergeConfigOverrides}, as `afterLayer` sees it. */
export interface ConfigMergeStep {
  layer: ConfigOverrideLayer;
  /** The base config the merge started from, before any layer. */
  base: AppConfig;
  /** The merged config before this layer applied its tombstones and overrides. */
  below: AppConfig;
  /**
   * What the layer's overrides contributed, under AppConfig section names (`mcpConfig`,
   * `interfaceConfig`, ...), after invalid, base-only and filtered values were removed.
   */
  applied: Readonly<Record<string, unknown>>;
  /** The merged config with this layer applied. */
  merged: AppConfig;
  /**
   * The base config with only this layer applied (its tombstones, then its overrides; where the
   * merge resolves Azure groups, each group it names as its item resolves over librechat.yaml's
   * group of that name, its key only where the layer supplies one), as if no other layer were
   * below it. Computed on first call.
   */
  alone: () => AppConfig;
}

export interface MergeConfigOverridesOptions extends ConfigDerivation {
  /**
   * Runs after each layer merges; the config it returns is what the next layer merges onto. A
   * caller uses it to apply a policy that depends on what a layer inherited and what it changed,
   * such as dropping an inherited credential the layer sends somewhere new.
   */
  afterLayer?: (step: ConfigMergeStep) => AppConfig;
  /**
   * Told about each stored web search key the merge withholds from the URL it was not entered
   * for, with the layer whose write moved it: the URL's writer when it is the later layer, and
   * otherwise the key's own. When given, it reports these instead of the merge's own warning.
   */
  onWebSearchKeyUnbound?: (unbound: WebSearchKeyUnbound) => void;
}

/** A stored web search key the merge withholds, and the layer whose write caused it. */
export interface WebSearchKeyUnbound {
  layer: ConfigOverrideLayer;
  url: TWebSearchKeys;
  apiKey: TWebSearchKeys;
}

/** One layer's step through {@link foldConfigLayers}, from which `ConfigMergeStep` is built. */
interface FoldStep<T> {
  layer: ConfigOverrideLayer;
  below: T;
  /** What the layer's overrides contributed, under AppConfig section names. */
  applied: AnyObject;
  merged: T;
  /**
   * What the layer removed before its overrides landed, as AppConfig paths: its tombstones that
   * applied (a tombstone of Azure `groups` with every field they resolve to).
   */
  removed: readonly string[];
}

/** The override document that last set or removed a paired web search field, and its merge position. */
interface WebSearchWriter {
  config: ConfigOverrideLayer;
  order: number;
  removed: boolean;
}

type WebSearchWriters = Map<TWebSearchKeys, WebSearchWriter>;

const WEB_SEARCH_TOMBSTONE_PREFIX = 'webSearch.';

/** Records `writer` for each paired web search field its applied overrides set. */
function recordWebSearchWrites(
  writers: WebSearchWriters,
  section: unknown,
  writer: WebSearchWriter,
): void {
  if (!isPlainObject(section)) {
    return;
  }
  for (const field of webSearchPairedFields) {
    if (hasOwn(section, field)) {
      writers.set(field, writer);
    }
  }
}

/** Records `writer` for each paired web search field an applied tombstone removes. */
function recordWebSearchTombstone(
  writers: WebSearchWriters,
  path: string,
  writer: WebSearchWriter,
): void {
  if (path === 'webSearch') {
    for (const field of webSearchPairedFields) {
      writers.set(field, writer);
    }
    return;
  }
  if (!path.startsWith(WEB_SEARCH_TOMBSTONE_PREFIX)) {
    return;
  }
  const field = path.slice(WEB_SEARCH_TOMBSTONE_PREFIX.length) as TWebSearchKeys;
  if (webSearchPairedFields.includes(field)) {
    writers.set(field, writer);
  }
}

function describeLayer(writer?: WebSearchWriter): string {
  return writer ? `${writer.config.principalType}/${writer.config.principalId}` : 'the base config';
}

/**
 * Withholds each stored web search key whose URL a layer other than the key's
 * own decides (`unbindWebSearchKeys`), so a layer that overrides only a URL
 * never sends on a key it cannot read. `writers` lists the override document
 * behind each field; unlisted fields come from the base config.
 */
function bindWebSearchKeys(
  merged: AppConfig,
  writers: WebSearchWriters,
  onUnbound?: MergeConfigOverridesOptions['onWebSearchKeyUnbound'],
): AppConfig {
  const { webSearch, unbound } = unbindWebSearchKeys(
    merged.webSearch,
    (field) => writers.get(field)?.order,
  );
  if (unbound.length === 0) {
    return merged;
  }
  for (const { url, apiKey } of unbound) {
    const urlWriter = writers.get(url);
    const keyWriter = writers.get(apiKey);
    if (onUnbound) {
      const cause = (urlWriter?.order ?? -1) > (keyWriter?.order ?? -1) ? urlWriter : keyWriter;
      if (cause) {
        onUnbound({ layer: cause.config, url, apiKey });
      }
      continue;
    }
    logger.warn(
      `[mergeConfigOverrides] Ignoring webSearch.${apiKey} from ${describeLayer(keyWriter)}: ` +
        `webSearch.${url} is ${urlWriter?.removed ? 'removed' : 'set'} by ${describeLayer(urlWriter)}. ` +
        'Store the key in the same config as the URL.',
    );
  }
  return { ...merged, webSearch };
}

function describePrincipal(config: ConfigOverrideLayer): string {
  return `${config.principalType}/${config.principalId}`;
}

/**
 * The document with only what the merge may apply: override keys and tombstones under a
 * top-level section `configSchema` defines. Anything else was stored before writes were
 * checked (or by another writer) and would reach runtime state no override may set, so it is
 * dropped here, which neutralizes it without a migration. One warning per document.
 */
function withAcceptedSections(
  config: ConfigOverrideLayer,
  sink?: LayerIgnoredSink,
): ConfigOverrideLayer {
  const ignored = new Set<string>();
  let overrides = config.overrides;
  if (isPlainObject(overrides)) {
    const accepted: AnyObject = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (isAcceptedOverrideSection(key)) {
        accepted[key] = value;
      } else {
        ignored.add(key);
        sink?.(toIgnored([key], 'unknown_section', 'override'));
      }
    }
    overrides = accepted as Partial<TCustomConfig>;
  }
  let tombstones = config.tombstones;
  if (Array.isArray(tombstones)) {
    tombstones = tombstones.filter((path) => {
      if (typeof path !== 'string') {
        return false;
      }
      const section = path.split('.')[0];
      if (isAcceptedOverrideSection(section)) {
        return true;
      }
      ignored.add(section);
      sink?.(toIgnored(path.split('.'), 'unknown_section', 'tombstone'));
      return false;
    });
  }
  if (ignored.size === 0) {
    return config;
  }
  if (sink) {
    return { ...config, overrides, tombstones };
  }
  logger.warn(
    `[mergeConfigOverrides] Ignoring unknown config sections ${[...ignored].join(', ')} for ${describePrincipal(config)}`,
  );
  return { ...config, overrides, tombstones };
}

/** What a layer's Azure `groups` resolve to: what the merge serves, and what the layer itself contributed. */
interface LayerAzureResolution {
  /** The merged Azure endpoint with the fields its groups decide resolved again. */
  served: AnyObject;
  /**
   * The layer's own Azure override with `groupMap` holding each group it names as its item
   * resolves over librechat.yaml's group of that name alone, the key only where the layer
   * supplies one: what the rebinding guard compares a layer's own key with (`alone()`).
   */
  contributed: AnyObject;
}

/** Whether a groups item supplies its own `apiKey` rather than inheriting the group's. */
function suppliesGroupKey(item: AnyObject | undefined): boolean {
  return item != null && hasOwn(item, 'apiKey') && item.apiKey !== undefined;
}

/** The key fields of a `groupMap` entry, which travel together. */
const AZURE_GROUP_KEY_FIELDS = ['apiKey', 'apiKeyPreview', 'apiKeyBinding'] as const;

/** A `groupMap` entry without its key fields. */
function withoutGroupKey(entry: AnyObject): AnyObject {
  const next: AnyObject = { ...entry };
  for (const field of AZURE_GROUP_KEY_FIELDS) {
    delete next[field];
  }
  return next;
}

/**
 * A layer's Azure `groups` resolved as AppService resolves librechat.yaml's
 * (`resolveServedAzureGroups`), merged by `group` over the groups below (the YAML-shaped config
 * up to the layer, `belowGroups`), as its `groups` array merges in that config: a group it names
 * merges over the group of that name (models by name), and a new one is added. The Azure clients
 * read `groupMap`, `modelGroupMap` and the model lists, never `groups`, so those are what change:
 * - `groupMap`: each group the layer names is resolved again; every other group keeps the entry
 *   below, as the merge left it. A named group keeps the key below unless the layer supplies one,
 *   so a key a lower layer's merge dropped stays dropped, and a group the config below does not
 *   serve (one a lower layer's tombstone left unable to resolve) has none: its YAML-shaped item
 *   still holds the key below it, which no layer below sends anywhere.
 * - `modelGroupMap` and the model lists: resolved from all the merged groups.
 * A resolved field the layer also writes directly merges over them (objects) or replaces them.
 * `null` when the merged groups do not resolve: the layer's groups then stay unread, with a
 * warning.
 */
function resolveLayerAzureGroups(params: {
  layerAzure: AnyObject;
  groups: AnyObject[];
  belowGroups: unknown;
  yamlGroups: unknown;
  served: AnyObject;
  below: unknown;
  config: ConfigOverrideLayer;
  sink?: LayerIgnoredSink;
}): LayerAzureResolution | null {
  const { layerAzure, groups, belowGroups, yamlGroups, served, below, config, sink } = params;
  const mergeOver = (lower: unknown): AnyObject[] =>
    Array.isArray(lower) ? mergeArrayByKey(lower, groups, 'group', 2, AZURE_GROUPS_PATH) : groups;
  const resolved = resolveServedAzureGroups(mergeOver(belowGroups), getGroupNames(groups));
  if (!resolved.isValid) {
    if (sink) {
      sink(toIgnored(AZURE_GROUPS_PATH.split('.'), 'invalid', 'override'));
    } else {
      logger.warn(
        `[mergeConfigOverrides] Ignoring ${AZURE_GROUPS_PATH} for ${describePrincipal(config)}: ${resolved.errors.join('; ')}`,
      );
    }
    return null;
  }
  const items = new Map<string, AnyObject>();
  for (const item of groups) {
    if (typeof item.group === 'string') {
      items.set(item.group, item);
    }
  }
  const belowMap = isPlainObject(below) && isPlainObject(below.groupMap) ? below.groupMap : {};
  const groupMap: AnyObject = { ...belowMap };
  for (const [name, item] of items) {
    const entry = resolved.groupMap[name] as AnyObject | undefined;
    if (entry == null) {
      continue;
    }
    if (suppliesGroupKey(item)) {
      groupMap[name] = entry;
      continue;
    }
    const inherited = isPlainObject(belowMap[name]) ? belowMap[name].apiKey : undefined;
    groupMap[name] =
      inherited === undefined ? withoutGroupKey(entry) : { ...entry, apiKey: inherited };
  }
  const alone: AnyObject = {};
  for (const item of mergeOver(yamlGroups)) {
    const name = item.group;
    const own = typeof name === 'string' ? items.get(name) : undefined;
    if (own == null || typeof name !== 'string') {
      continue;
    }
    const entry = toAzureGroupMapEntry(item);
    alone[name] = suppliesGroupKey(own) ? entry : withoutGroupKey(entry);
  }
  const ownMap = layerAzure.groupMap;
  const derived: Record<AzureResolvedGroupField, unknown> = {
    groupMap,
    modelGroupMap: resolved.modelGroupMap,
    modelNames: resolved.modelNames,
    assistantModels: resolved.assistantModels,
    assistantGroups: resolved.assistantGroups,
  };
  const next: AnyObject = { ...served };
  for (const field of AZURE_RESOLVED_GROUP_FIELDS) {
    const own = layerAzure[field];
    const value = derived[field];
    next[field] =
      isPlainObject(own) && isPlainObject(value) ? deepMerge(value, own) : (own ?? value);
  }
  return {
    served: next,
    contributed: {
      ...layerAzure,
      groupMap: isPlainObject(ownMap) ? deepMerge(alone, ownMap) : alone,
    },
  };
}

/**
 * `merged` with the Azure model lists narrowed to what its groups serve
 * (`narrowAzureServedModels`), and Azure assistants turned off when none of the models it serves
 * supports them (`lacksAzureAssistantModels`), a combination `azureConfigSetup` refuses in
 * librechat.yaml. A list an override writes directly, or one whose groups a later layer replaced
 * or tombstoned, could otherwise name a model no group serves, and groups without an assistant
 * model under an inherited `assistants: true` would leave the Azure Assistants client no model to
 * default to. Judged on the merged result, so a later layer whose groups serve assistants keeps
 * them on. An Azure endpoint the layers leave without the fields its groups resolve to (one a
 * layer recreates after a tombstone of it or of `endpoints`) serves no group
 * (`completeAzureResolution`), with or without `rederiveEndpoints`: nothing of what the removed
 * groups resolved to survives the tombstone.
 */
function withServedAzureModels<T extends AppConfig>(
  merged: T,
  configs: readonly ConfigOverrideLayer[],
): T {
  const endpoints = merged.endpoints;
  const azure = endpoints?.[EModelEndpoint.azureOpenAI];
  if (!endpoints || !azure) {
    return merged;
  }
  const principals = configs.map(describePrincipal).join(', ');
  const { config: complete, completed } = completeAzureResolution(azure);
  if (completed.length > 0) {
    logger.warn(
      `[mergeConfigOverrides] Serving no Azure group for ${principals}: the ${AZURE_CONFIG_PATH} they leave has no groups that resolve`,
    );
  }
  const { config: served, narrowed } = narrowAzureServedModels(complete);
  if (narrowed.length > 0) {
    logger.warn(
      `[mergeConfigOverrides] Leaving out of ${narrowed.map((field) => `${AZURE_CONFIG_PATH}.${field}`).join(', ')} for ${principals} the Azure models and groups no merged group serves`,
    );
  }
  const assistantsOff = lacksAzureAssistantModels(served);
  if (assistantsOff) {
    logger.warn(
      `[mergeConfigOverrides] Turning off ${AZURE_CONFIG_PATH}.assistants for ${principals}: none of the Azure models they serve supports assistants`,
    );
  }
  if (completed.length === 0 && narrowed.length === 0 && !assistantsOff) {
    return merged;
  }
  return {
    ...merged,
    endpoints: {
      ...endpoints,
      [EModelEndpoint.azureOpenAI]: assistantsOff ? { ...served, assistants: false } : served,
    },
  };
}

/** A keyed tombstone of an Azure group (`endpoints.azureOpenAI.groups["g"]`, or a path inside it). */
function readAzureGroupTombstone(path: string): ConfigEntryLocation | null {
  const entry = isKeyedConfigPath(path) ? readConfigEntryTombstone(path) : null;
  return entry != null && entry.segments.join('.') === AZURE_GROUPS_PATH ? entry : null;
}

/** Whether a tombstone removes Azure groups and nothing else: the whole list, or a keyed one. */
function isAzureGroupsTombstone(path: string): boolean {
  return path === AZURE_GROUPS_PATH || readAzureGroupTombstone(path) != null;
}

/** The Azure groups a layer's keyed tombstones name (`endpoints.azureOpenAI.groups["g"]`), whole or not. */
function getAzureGroupTombstones(tombstones: readonly string[]): {
  hidden: Set<string>;
  touched: Set<string>;
} {
  const hidden = new Set<string>();
  const touched = new Set<string>();
  for (const path of tombstones) {
    const entry = readAzureGroupTombstone(path);
    if (entry != null) {
      (entry.entry.rest.length === 0 ? hidden : touched).add(entry.identity);
    }
  }
  return { hidden, touched };
}

/** {@link withHiddenAzureGroups}' result: the served config, and the groups it no longer serves. */
interface HiddenAzureGroups<T> {
  merged: T;
  /** The groups with a path hidden inside them that the groups left do not let resolve. */
  unresolved: ReadonlySet<string>;
}

/**
 * `merged` once a layer's keyed tombstones of Azure groups (`tombstones`) applied, where the merge
 * resolves Azure groups: the groups the YAML-shaped config keeps (`raw`) resolved again, as a
 * layer's own groups are (`resolveLayerAzureGroups`). A hidden group leaves `groupMap`, and
 * `modelGroupMap` and the model lists are resolved from the groups left. A group with a path
 * hidden inside it is resolved again from what it keeps, with the key below it, which a tombstone
 * never supplies; every other group keeps the entry below. Where the groups left do not resolve,
 * the groups with a path hidden inside them are served no more either (`unresolved`, judged on
 * `raw` alone, with a warning unless `quiet`); where none is left, no group is served
 * (`withoutAzureGroups`).
 */
function withHiddenAzureGroups<T extends AnyObject>(
  merged: T,
  raw: Partial<TCustomConfig>,
  tombstones: readonly string[],
  config: ConfigOverrideLayer,
  quiet = false,
): HiddenAzureGroups<T> {
  const { hidden, touched } = getAzureGroupTombstones(tombstones);
  if (hidden.size === 0 && touched.size === 0) {
    return { merged, unresolved: new Set() };
  }
  const azureSegments = AZURE_CONFIG_PATH.split('.');
  const azure = getPath(merged, azureSegments);
  const kept = getPath(raw, AZURE_GROUPS_PATH.split('.'));
  let groups = Array.isArray(kept) ? kept.filter(isPlainObject) : [];
  let resolved = resolveServedAzureGroups(groups, touched);
  const unresolved = resolved.isValid ? new Set<string>() : touched;
  if (!resolved.isValid) {
    if (!quiet && isPlainObject(azure)) {
      logger.warn(
        `[mergeConfigOverrides] Serving none of the ${AZURE_GROUPS_PATH} ${[...touched].join(', ')} for ${describePrincipal(config)}: they do not resolve once its tombstones apply: ${resolved.errors.join('; ')}`,
      );
    }
    groups = groups.filter((item) => typeof item.group !== 'string' || !touched.has(item.group));
    resolved = resolveServedAzureGroups(groups, new Set());
  }
  if (!isPlainObject(azure)) {
    return { merged, unresolved };
  }
  if (groups.length === 0 || !resolved.isValid) {
    return { merged: withoutAzureGroups(merged), unresolved };
  }
  const belowMap = isPlainObject(azure.groupMap) ? azure.groupMap : {};
  const groupMap: AnyObject = {};
  for (const [name, entry] of Object.entries(resolved.groupMap)) {
    const below = belowMap[name];
    if (!touched.has(name) && isPlainObject(below)) {
      groupMap[name] = below;
      continue;
    }
    const next: AnyObject = { ...(entry as AnyObject) };
    for (const field of AZURE_GROUP_KEY_FIELDS) {
      if (isPlainObject(below) && below[field] !== undefined) {
        next[field] = below[field];
      } else {
        delete next[field];
      }
    }
    groupMap[name] = next;
  }
  const next = setPath(merged, azureSegments, {
    ...azure,
    groupMap,
    modelGroupMap: resolved.modelGroupMap,
    modelNames: resolved.modelNames,
    assistantModels: resolved.assistantModels,
    assistantGroups: resolved.assistantGroups,
  }) as T;
  return { merged: next, unresolved };
}

/** What {@link foldConfigLayers} leaves: the served config, the YAML-shaped one, and what layers wrote. */
interface FoldResult<T> {
  merged: T;
  raw: Partial<TCustomConfig>;
  webSearchWriters: WebSearchWriters;
  touches: ConfigTouches;
}

/** Where Vertex AI sits in librechat.yaml (and, unresolved, in an AppConfig). */
const VERTEX_SEGMENTS = ['endpoints', EModelEndpoint.anthropic, 'vertex'];

/** The Anthropic models a layer serves over Vertex AI's. */
const ANTHROPIC_MODELS_SEGMENTS = ['endpoints', EModelEndpoint.anthropic, 'models'];

/** Whether a tombstone path removes Azure `groups`: the groups, or an object holding them. */
function removesAzureGroups(path: string): boolean {
  return AZURE_GROUPS_PATH === path || AZURE_GROUPS_PATH.startsWith(`${path}.`);
}

/** What a tracked fold records about one layer (`resolveConfigLayers`). */
interface LayerTrack {
  /** The document as given. */
  layer: ConfigOverrideLayer;
  /** The document the fold read: `layer` with only accepted sections (`withAcceptedSections`). */
  accepted: ConfigOverrideLayer;
  /**
   * What its overrides contributed to the YAML-shaped result, under AppConfig section names:
   * invalid, base-only and filtered values removed, Azure `groups` as written.
   */
  contributed: AnyObject;
  /** The tombstones the fold applied, in librechat.yaml keys. */
  tombstoned: string[];
  ignored: AdminConfigLayerIgnored[];
}

/**
 * A fold's record of the YAML-shaped result and of what each layer could not apply. `resolved`
 * is `librechat.yaml` folded exactly as `merged` is (same tombstones, filters, merge keys and
 * atomic paths), kept under AppConfig section names (`interfaceConfig`, `mcpConfig`, ...) so the
 * merge rules address it as they address `merged`.
 */
interface FoldTracker {
  resolved: AnyObject;
  layers: LayerTrack[];
}

function toLayerIgnored(
  segments: readonly string[],
  reason: AdminConfigLayerIgnoreReason,
  extra?: Pick<AdminConfigLayerIgnored, 'code' | 'tombstone'>,
): AdminConfigLayerIgnored {
  return { path: segments.join('.'), segments: [...segments], reason, ...extra };
}

/** A reason both a write's `ignored` and a resolution's layer list give. */
type SharedIgnoreReason = AdminConfigIgnoreReason & AdminConfigLayerIgnoreReason;

/**
 * Where an ignored tombstone sits: its path as stored, which DELETE `/fields` takes, and its
 * segments, with a keyed tombstone's entry named by its key, as write responses name a
 * credential in one.
 */
function getTombstoneLocation(path: string): { path: string; segments: string[] } {
  const entry = isKeyedConfigPath(path) ? readConfigEntryTombstone(path) : null;
  return {
    path,
    segments: entry ? [...entry.segments, entry.entry.key, ...entry.entry.rest] : path.split('.'),
  };
}

/** `tree` with its top-level keys in AppConfig names (`interface` → `interfaceConfig`, ...). */
function toAppConfigKeys(tree: Partial<TCustomConfig>): AnyObject {
  const result: AnyObject = {};
  for (const [key, value] of Object.entries(tree)) {
    if (value !== undefined) {
      result[OVERRIDE_KEY_MAP[key as keyof typeof OVERRIDE_KEY_MAP] ?? key] = value;
    }
  }
  return result;
}

/** `tree` with its top-level keys back in librechat.yaml names. */
function toOverrideKeys(tree: AnyObject): Partial<TCustomConfig> {
  const result: AnyObject = {};
  for (const [key, value] of Object.entries(tree)) {
    if (value !== undefined) {
      result[OVERRIDE_SECTION_BY_APP_KEY.get(key) ?? key] = value;
    }
  }
  return result as Partial<TCustomConfig>;
}

/** Starts a layer's record with the sections `withAcceptedSections` left out of it. */
function startLayerTrack(
  tracker: FoldTracker,
  layer: ConfigOverrideLayer,
  accepted: ConfigOverrideLayer,
): LayerTrack {
  const ignored: AdminConfigLayerIgnored[] = [];
  if (accepted !== layer) {
    if (isPlainObject(layer.overrides)) {
      for (const key of Object.keys(layer.overrides)) {
        if (!isAcceptedOverrideSection(key)) {
          ignored.push(toLayerIgnored([key], 'unknown_section'));
        }
      }
    }
    for (const path of Array.isArray(layer.tombstones) ? layer.tombstones : []) {
      if (typeof path === 'string' && !isAcceptedOverrideSection(path.split('.')[0])) {
        ignored.push(toLayerIgnored(path.split('.'), 'unknown_section', { tombstone: true }));
      }
    }
  }
  const track: LayerTrack = { layer, accepted, contributed: {}, tombstoned: [], ignored };
  tracker.layers.push(track);
  return track;
}

/** The interface fields and sub-keys the permission filter removes from an interface override. */
function getInterfacePermissionRemovals(value: AnyObject): string[][] {
  const removed: string[][] = [];
  for (const [field, fieldVal] of Object.entries(value)) {
    if (!INTERFACE_PERMISSION_FIELDS.has(field)) {
      continue;
    }
    if (isPlainObject(fieldVal)) {
      for (const sub of Object.keys(fieldVal)) {
        if (PERMISSION_SUB_KEYS.has(sub)) {
          removed.push(['interface', field, sub]);
        }
      }
    } else if (!RUNTIME_CONFIG_INTERFACE_FIELDS.has(field)) {
      removed.push(['interface', field]);
    }
  }
  return removed;
}

/**
 * Reports what a tombstone leaves in place: a field only librechat.yaml sets, at or below the
 * tombstone (the whole tombstone) or below it where the base config has a value the merge puts
 * back (`isHeldValueSet`), and the MCP servers librechat.yaml runs as local processes (`merged`
 * is the config below the layer).
 */
function reportTombstoneHeld(
  path: string,
  merged: AnyObject,
  isHeldValueSet: (held: YamlHeldPath) => boolean,
  sink: LayerIgnoredSink,
): void {
  const segments = path.split('.');
  for (const held of YAML_HELD_PATHS) {
    if (isSegmentPrefix(held.segments, segments)) {
      sink(toIgnored(segments, held.reason, 'tombstone'));
    } else if (isSegmentPrefix(segments, held.segments) && isHeldValueSet(held)) {
      sink(toIgnored(held.segments, held.reason, 'tombstone'));
    }
  }
  const servers = merged.mcpConfig;
  if (segments[0] !== 'mcpServers' || !isPlainObject(servers)) {
    return;
  }
  const names = segments.length > 1 ? [segments[1]] : Object.keys(servers);
  for (const name of names) {
    if (isProcessMCPServerConfig(servers[name])) {
      const location = segments.length > 1 ? segments : ['mcpServers', name];
      sink(toIgnored(location, 'process_mcp_server', 'tombstone'));
    }
  }
}

/** What a fold reports beside its result (`foldConfigLayers`). */
interface FoldObservers {
  /** Told about each stored override or tombstone a layer's fold leaves out. */
  sink?: IgnoredSink;
  /**
   * For the `sink`: whether the merge puts back a held field below a tombstone; by default,
   * whether the initial raw config (librechat.yaml) sets it.
   */
  isHeldValueSet?: (held: YamlHeldPath) => boolean;
  /** Keeps the YAML-shaped result and each layer's unapplied parts. */
  tracker?: FoldTracker;
}

/**
 * Folds override layers, in merge precedence order (`compareConfigPrecedence`), into
 * `merged`, the served config, and `raw`, the YAML-shaped config each layer is validated on
 * before it lands (`stripInvalidOverrides`). `merged` starts as any object whose `mcpConfig`
 * is the MCP servers config of `raw`, because the process-MCP filter reads it. A layer's Azure
 * `groups` always merge by `group` over the groups below in `raw`. With
 * `options.rederiveEndpoints`, they also resolve into the fields the Azure clients read
 * (`resolveLayerAzureGroups`), a tombstone of them removes those fields, and a layer that writes
 * or removes `endpoints.anthropic.vertex`, or removes `endpoints.anthropic.models`, has Vertex AI
 * derived again (`deriveVertexEndpoint`), keeping the models a layer set only while no later
 * layer has removed them, and a tombstone inside a group that leaves it unable to resolve is
 * reported (`azure_groups_unresolved`);
 * without it, those overrides stay inert in `merged`, as before the merge derived them, and a
 * layer's Azure groups and its tombstones of them are reported (`endpoint_rederive_off`). Layers
 * are judged with `vertexConfigured` taken from `initialRaw`, librechat.yaml.
 * `webSearchWriters` names the layer behind each paired web search field, by its position in
 * that order, and `touches` what the layers wrote and removed. `afterLayer` runs after each layer
 * lands, and the next layer folds onto what it returns. With a `sink`, the fold tells it what of
 * each stored layer it leaves out (`getIgnoredConfigOverrides`); with a `tracker`, it also keeps
 * the YAML-shaped result the served config corresponds to, and what of each layer it did not
 * apply (`resolveConfigLayers`).
 */
function foldConfigLayers<T extends AnyObject>(
  initial: T,
  initialRaw: Partial<TCustomConfig>,
  configs: readonly ConfigOverrideLayer[],
  afterLayer?: (step: FoldStep<T>) => T,
  options: ConfigDerivation = {},
  {
    sink,
    tracker,
    isHeldValueSet = (held) => getPath(initialRaw, [...held.segments]) !== undefined,
  }: FoldObservers = {},
): FoldResult<T> {
  const derivation: ConfigDerivation = {
    ...options,
    vertexConfigured: isVertexConfigured(initialRaw),
  };
  const sorted = sortByConfigPrecedence(configs);
  let merged = initial;
  let raw = initialRaw;
  const webSearchWriters: WebSearchWriters = new Map();
  const touches = createConfigTouches();
  const resolvesAzureGroups = derivation.rederiveEndpoints === true;
  let anthropicModelsSet = false;
  for (let order = 0; order < sorted.length; order++) {
    const source = sorted[order];
    const layerSink: LayerIgnoredSink | undefined = sink && ((entry) => sink(source, entry));
    const config = withAcceptedSections(source, layerSink);
    const track = tracker && startLayerTrack(tracker, source, config);
    const below = merged;
    let contributed: AnyObject = {};
    const removed: string[] = [];
    const tombstoned: string[] = [];
    let appliedOverrides: AnyObject = {};
    const isBasePrincipal = isBaseConfigPrincipal(config);
    if (Array.isArray(config.tombstones)) {
      const removal: WebSearchWriter = { config, order, removed: true };
      for (const path of config.tombstones) {
        if (typeof path !== 'string') {
          continue;
        }
        if (isBaseOnlyOverridePath(path)) {
          layerSink?.(toIgnored(path.split('.'), 'base_only_section', 'tombstone'));
          track?.ignored.push(
            toLayerIgnored(path.split('.'), 'base_only_section', { tombstone: true }),
          );
          continue;
        }
        if (!isBasePrincipal && BASE_PRINCIPAL_OVERRIDE_SECTIONS.has(path.split('.')[0])) {
          layerSink?.(toIgnored(path.split('.'), 'dedicated_section', 'tombstone'));
          track?.ignored.push(
            toLayerIgnored(path.split('.'), 'base_principal_section', { tombstone: true }),
          );
          continue;
        }
        if (isDerivedConfigPath(path.split('.'))) {
          layerSink?.(toIgnored(path.split('.'), 'derived_path', 'tombstone'));
          track?.ignored.push(toLayerIgnored(path.split('.'), 'derived_path', { tombstone: true }));
          continue;
        }
        if (layerSink) {
          reportTombstoneHeld(path, merged, isHeldValueSet, layerSink);
        }
        tombstoned.push(path);
        for (const removedPath of getTombstoneRemovals(path, resolvesAzureGroups)) {
          const mappedPath = remapOverridePath(removedPath);
          removed.push(mappedPath);
          merged = deleteConfigPath(merged, mappedPath);
          raw = deletePath(raw as AnyObject, removedPath) as Partial<TCustomConfig>;
          if (tracker) {
            tracker.resolved = deleteConfigPath(tracker.resolved, mappedPath);
          }
        }
        if (resolvesAzureGroups && path === AZURE_GROUPS_PATH) {
          merged = withoutAzureGroups(merged);
        }
        track?.tombstoned.push(path);
        recordWebSearchTombstone(webSearchWriters, path, removal);
      }
      const reportTombstone = (path: string, reason: SharedIgnoreReason) => {
        const location = getTombstoneLocation(path);
        layerSink?.({ ...location, reason, kind: 'tombstone' });
        track?.ignored.push({ ...location, reason, tombstone: true });
      };
      if (resolvesAzureGroups) {
        const hidden = withHiddenAzureGroups(merged, raw, tombstoned, config, layerSink != null);
        merged = hidden.merged;
        for (const path of tombstoned) {
          const entry = readAzureGroupTombstone(path);
          if (
            entry != null &&
            entry.entry.rest.length > 0 &&
            hidden.unresolved.has(entry.identity)
          ) {
            reportTombstone(path, 'azure_groups_unresolved');
          }
        }
      } else {
        for (const path of tombstoned.filter(isAzureGroupsTombstone)) {
          reportTombstone(path, 'endpoint_rederive_off');
        }
      }
    }

    if (config.overrides && typeof config.overrides === 'object') {
      const remapped: AnyObject = {};
      const applied: AnyObject = {};
      const valid = stripInvalidOverrides(
        config,
        raw,
        derivation,
        layerSink,
        track &&
          ((issue) =>
            track.ignored.push(
              toLayerIgnored(issue.segments, 'invalid_override', { code: issue.code }),
            )),
      );
      const writable = withoutDerivedPaths(
        valid,
        describePrincipal(config),
        layerSink || track
          ? (segments) => {
              layerSink?.(toIgnored(segments, 'derived_path', 'override'));
              track?.ignored.push(toLayerIgnored(segments, 'derived_path'));
            }
          : undefined,
      );
      for (const [key, value] of Object.entries(writable)) {
        if (BASE_ONLY_OVERRIDE_SECTIONS.has(key)) {
          layerSink?.(toIgnored([key], 'base_only_section', 'override'));
          track?.ignored.push(toLayerIgnored([key], 'base_only_section'));
          continue;
        }
        if (!isBasePrincipal && BASE_PRINCIPAL_OVERRIDE_SECTIONS.has(key)) {
          layerSink?.(toIgnored([key], 'dedicated_section', 'override'));
          track?.ignored.push(toLayerIgnored([key], 'base_principal_section'));
          continue;
        }
        applied[key] = value;
        const mappedKey = OVERRIDE_KEY_MAP[key as keyof typeof OVERRIDE_KEY_MAP] ?? key;
        if (mappedKey === 'mcpConfig') {
          remapped[mappedKey] = filterMCPServerOverrides(
            value,
            merged[mappedKey],
            layerSink &&
              ((name) => layerSink(toIgnored([key, name], 'process_mcp_server', 'override'))),
          );
          /** A server the filter removed must not complete a later layer's partial of it. */
          applied[key] = remapped[mappedKey];
          if (track && isPlainObject(value)) {
            for (const name of Object.keys(value)) {
              if (!hasOwn(remapped[mappedKey] as AnyObject, name)) {
                track.ignored.push(toLayerIgnored([key, name], 'process_mcp_server'));
              }
            }
          }
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
                } else {
                  layerSink?.(toIgnored([key, field, sub], 'interface_permission', 'override'));
                }
              }
              if (Object.keys(uiOnly).length > 0) {
                filtered[field] = uiOnly;
              }
            } else if (RUNTIME_CONFIG_INTERFACE_FIELDS.has(field)) {
              // Dual-purpose field: the boolean form is a runtime disable, not a
              // permission toggle, so preserve it (e.g. schedules: false).
              filtered[field] = fieldVal;
            } else {
              // other boolean permission fields (e.g. runCode: false) are fully stripped
              layerSink?.(toIgnored([key, field], 'interface_permission', 'override'));
            }
          }
          if (Object.keys(filtered).length > 0) {
            remapped[mappedKey] = filtered;
          }
          for (const segments of track ? getInterfacePermissionRemovals(value as AnyObject) : []) {
            track?.ignored.push(toLayerIgnored(segments, 'interface_permission'));
          }
        } else {
          remapped[mappedKey] = value;
        }
      }
      const beforeOverrides = merged;
      const rawBelow = raw;
      if (layerSink) {
        for (const held of YAML_HELD_PATHS) {
          if (getPath(applied, [...held.segments]) !== undefined) {
            layerSink(toIgnored(held.segments, held.reason, 'override'));
          }
        }
      }
      merged = deepMerge(merged, remapped);
      raw = deepMerge(raw as AnyObject, applied) as Partial<TCustomConfig>;
      recordWebSearchWrites(webSearchWriters, applied.webSearch, {
        config,
        order,
        removed: false,
      });
      contributed = remapped;
      appliedOverrides = applied;
      if (tracker && track) {
        track.contributed = remapped;
        tracker.resolved = deepMerge(tracker.resolved, track.contributed);
      }
      const layerAzure = getPath(applied, AZURE_CONFIG_PATH.split('.'));
      const groupsSegments = AZURE_GROUPS_PATH.split('.');
      if (!resolvesAzureGroups && isPlainObject(layerAzure) && Array.isArray(layerAzure.groups)) {
        layerSink?.(toIgnored(groupsSegments, 'endpoint_rederive_off', 'override'));
        track?.ignored.push(toLayerIgnored(groupsSegments, 'endpoint_rederive_off'));
      }
      if (resolvesAzureGroups && isPlainObject(layerAzure) && Array.isArray(layerAzure.groups)) {
        const azureSegments = AZURE_CONFIG_PATH.split('.');
        const resolution = resolveLayerAzureGroups({
          layerAzure,
          groups: layerAzure.groups.filter(isPlainObject),
          belowGroups: getPath(rawBelow, groupsSegments),
          yamlGroups: tombstoned.some(removesAzureGroups)
            ? undefined
            : getPath(initialRaw, groupsSegments),
          served: (getPath(merged, azureSegments) as AnyObject | undefined) ?? {},
          below: getPath(beforeOverrides, azureSegments),
          config,
          sink: layerSink,
        });
        if (resolution) {
          merged = setPath(merged, azureSegments, resolution.served) as T;
          contributed = setPath(remapped, azureSegments, resolution.contributed) as AnyObject;
        } else {
          track?.ignored.push(toLayerIgnored(groupsSegments, 'azure_groups_unresolved'));
        }
      }
    }

    recordConfigTouches(touches, appliedOverrides, tombstoned);
    const anthropicModelsRemoved = tombstoned.some((path) =>
      isRelatedPath(path.split('.'), ANTHROPIC_MODELS_SEGMENTS),
    );
    anthropicModelsSet =
      getPath(appliedOverrides, ANTHROPIC_MODELS_SEGMENTS) !== undefined ||
      (anthropicModelsSet && !anthropicModelsRemoved);
    if (
      derivation.rederiveEndpoints === true &&
      (anthropicModelsRemoved ||
        getPath(appliedOverrides, VERTEX_SEGMENTS) !== undefined ||
        tombstoned.some((path) => isRelatedPath(path.split('.'), VERTEX_SEGMENTS)))
    ) {
      const derived = deriveVertexEndpoint({
        merged,
        raw: raw as AnyObject,
        baseYaml: initialRaw as AnyObject,
        modelsOverridden: anthropicModelsSet,
        principal: describePrincipal(config),
      });
      if (derived !== merged) {
        merged = derived;
        const anthropicSegments = ['endpoints', EModelEndpoint.anthropic];
        contributed = setPath(
          contributed,
          anthropicSegments,
          getPath(derived, anthropicSegments),
        ) as AnyObject;
      }
    }

    if (afterLayer) {
      merged = afterLayer({ layer: config, below, applied: contributed, merged, removed });
    }
  }
  return { merged, raw, webSearchWriters, touches };
}

/** A config merged from override layers, and the librechat.yaml-shaped config they merge to. */
export interface ConfigMergeResult {
  appConfig: AppConfig;
  /**
   * librechat.yaml with the applied layers merged over it, keys as librechat.yaml names them: what
   * the next layer would be validated on, and what derived values are derived from.
   */
  raw: Partial<TCustomConfig>;
}

/** One layer of {@link resolveConfigLayers}: the document as given, and what the merge left out. */
export interface ConfigLayerResolution {
  layer: ConfigOverrideLayer;
  ignored: AdminConfigLayerIgnored[];
}

/** {@link resolveConfigLayers}' result. */
export interface ConfigLayersResolution {
  /** Exactly what {@link mergeConfigOverrides} returns for the same arguments. */
  merged: AppConfig;
  /**
   * The librechat.yaml-shaped config the fold leaves, as {@link mergeConfigOverridesWithSource}
   * returns it: what a caller derives the parts only the final config decides from.
   */
  raw: Partial<TCustomConfig>;
  /** The same merge in librechat.yaml shape: `baseConfig.config` with every layer folded in. */
  resolved: Partial<TCustomConfig>;
  /** Every layer, in merge precedence order. */
  layers: ConfigLayerResolution[];
}

/** The layers of a tracked fold whose contribution holds a value at `segments` (AppConfig keys). */
function getWriters(tracker: FoldTracker, segments: readonly string[]): LayerTrack[] {
  return tracker.layers.filter((track) => getPath(track.contributed, [...segments]) !== undefined);
}

/**
 * The layers of a tracked fold that applied a tombstone at or under `path` (librechat.yaml keys),
 * or with `ancestors`, above it as well: a tombstone of `endpoints.agents` removes
 * `endpoints.agents.pullRequests.host` with the rest.
 */
function getTombstoners(tracker: FoldTracker, path: string, ancestors: boolean): LayerTrack[] {
  return tracker.layers.filter((track) =>
    track.tombstoned.some(
      (tombstone) =>
        tombstone === path ||
        tombstone.startsWith(`${path}.`) ||
        (ancestors && path.startsWith(`${tombstone}.`)),
    ),
  );
}

/** Sets or removes (`undefined`) the value at `segments` of the tracker's resolved tree. */
function setResolved(tracker: FoldTracker, segments: readonly string[], value: unknown): void {
  tracker.resolved =
    value === undefined
      ? deletePath(tracker.resolved, segments.join('.'))
      : (setPath(tracker.resolved, [...segments], value) as AnyObject);
}

/**
 * Replays on the YAML-shaped result what {@link withServedAzureModels} did to the served config:
 * an Azure model list a layer wrote directly, narrowed to what the merged groups serve, and
 * `assistants` turned off when none of them supports assistants.
 */
function replayAzureServed(tracker: FoldTracker, before: AppConfig, after: AppConfig): void {
  const segments = AZURE_CONFIG_PATH.split('.');
  const served = getPath(after, segments);
  const resolved = getPath(tracker.resolved, segments);
  if (served === getPath(before, segments) || !isPlainObject(served) || !isPlainObject(resolved)) {
    return;
  }
  for (const field of ['assistants', 'modelNames', 'assistantModels', 'assistantGroups']) {
    if (!hasOwn(resolved, field) || isSameJson(resolved[field], served[field])) {
      continue;
    }
    setResolved(tracker, [...segments, field], served[field]);
    const writers =
      field === 'assistants'
        ? getWriters(tracker, segments)
        : getWriters(tracker, [...segments, field]);
    for (const track of writers) {
      track.ignored.push(toLayerIgnored([...segments, field], 'azure_unserved'));
    }
  }
}

/**
 * Replays on the YAML-shaped result what {@link preserveRuntimeStops} did to the served config:
 * an interface feature the base config turns off stays off, in the shape the layers left it, or
 * `false` where a tombstone removed it. Each layer that wrote it or tombstoned it, or anything
 * above or below it, is told.
 */
function replayRuntimeStops(tracker: FoldTracker, baseConfig: AppConfig): void {
  const baseInterface = (baseConfig as unknown as AnyObject).interfaceConfig;
  const resolvedInterface = tracker.resolved.interfaceConfig;
  if (!isPlainObject(baseInterface) || !isPlainObject(resolvedInterface)) {
    return;
  }
  for (const key of RUNTIME_CONFIG_INTERFACE_FIELDS) {
    if (!isRuntimeDisabled(baseInterface[key]) || isRuntimeDisabled(resolvedInterface[key])) {
      continue;
    }
    const current = resolvedInterface[key];
    setResolved(
      tracker,
      ['interfaceConfig', key],
      isPlainObject(current) ? { ...current, use: false } : false,
    );
    const segments = ['interface', key];
    for (const track of getWriters(tracker, ['interfaceConfig', key])) {
      track.ignored.push(toLayerIgnored(segments, 'runtime_stop'));
    }
    for (const track of getTombstoners(tracker, segments.join('.'), true)) {
      track.ignored.push(toLayerIgnored(segments, 'runtime_stop', { tombstone: true }));
    }
  }
}

/**
 * Replays on the YAML-shaped result what {@link preserveBaseOnlyPaths} did to the served config:
 * each field only librechat.yaml sets (`YAML_HELD_PATHS`: base-only and deployment-only) keeps
 * the value `librechat.yaml` gives it. A layer is told when it wrote one, tombstoned one or
 * anything below it, or tombstoned anything above one `librechat.yaml` sets, as write responses
 * tell it (`base_only_path`, `deployment_only_path`).
 */
function replayBaseOnlyPaths(tracker: FoldTracker, baseYaml: Partial<TCustomConfig>): void {
  for (const { segments, reason } of YAML_HELD_PATHS) {
    const path = segments.join('.');
    const appSegments = remapOverridePath(path).split('.');
    const value = getPath(baseYaml, [...segments]);
    const writers = getWriters(tracker, appSegments);
    const tombstoners = getTombstoners(tracker, path, value !== undefined);
    if (writers.length === 0 && tombstoners.length === 0) {
      continue;
    }
    setResolved(tracker, appSegments, value);
    for (const track of writers) {
      track.ignored.push(toLayerIgnored(segments, reason));
    }
    for (const track of tombstoners) {
      track.ignored.push(toLayerIgnored(segments, reason, { tombstone: true }));
    }
  }
}

function isSameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The merge {@link mergeConfigOverridesWithSource} runs, and with a `tracker` the YAML-shaped
 * result and each layer's unapplied parts, replaying on that result each step the served config
 * takes after the fold.
 */
function mergeLayers(
  baseConfig: AppConfig,
  configs: readonly ConfigOverrideLayer[],
  options: MergeConfigOverridesOptions,
  tracker?: FoldTracker,
): ConfigMergeResult {
  const { afterLayer, expandCustomEndpoint, rederiveEndpoints } = options;
  const derivation: ConfigDerivation = { expandCustomEndpoint, rederiveEndpoints };
  const folded = foldConfigLayers(
    { ...baseConfig },
    baseConfig.config ?? {},
    configs,
    afterLayer &&
      (({ layer, below, applied, merged, removed }) => {
        let alone: AppConfig | undefined;
        return afterLayer({
          layer,
          base: baseConfig,
          below,
          applied,
          merged,
          alone: () => {
            alone ??= deepMerge(
              removed.reduce((current, path) => deleteConfigPath(current, path), { ...baseConfig }),
              applied,
            );
            return alone;
          },
        });
      }),
    derivation,
    { tracker },
  );
  const served = withServedAzureModels(folded.merged, configs);
  if (tracker) {
    replayAzureServed(tracker, folded.merged, served);
  }
  const derived = rederiveMergedConfig({
    merged: served,
    raw: folded.raw as AnyObject,
    base: baseConfig,
    touches: folded.touches,
    derivation,
    principals: configs.map(describePrincipal).join(', '),
  });
  const unbound: WebSearchKeyUnbound[] = [];
  const onUnbound =
    tracker || options.onWebSearchKeyUnbound
      ? (binding: WebSearchKeyUnbound) => {
          unbound.push(binding);
          options.onWebSearchKeyUnbound?.(binding);
        }
      : undefined;
  const bound = bindWebSearchKeys(derived, folded.webSearchWriters, onUnbound);
  if (tracker) {
    for (const { layer, apiKey } of unbound) {
      setResolved(tracker, ['webSearch', apiKey], bound.webSearch?.[apiKey]);
      tracker.layers
        .find((track) => track.accepted === layer)
        ?.ignored.push(toLayerIgnored(['webSearch', apiKey], 'secret_rebinding'));
    }
    replayRuntimeStops(tracker, baseConfig);
    replayBaseOnlyPaths(tracker, baseConfig.config ?? {});
  }
  return {
    appConfig: preserveBaseOnlyPaths(baseConfig, preserveRuntimeStops(baseConfig, bound)),
    raw: folded.raw,
  };
}

/**
 * Merge DB config overrides into a base AppConfig.
 *
 * Configs merge in precedence order (`compareConfigPrecedence`): Base first, then ascending
 * priority, then role < group < user, then document identity; the last layer wins. Each
 * config's `overrides` is deep-merged into the base config in that order. A stored web search
 * key is dropped when a layer other than its own decides the URL it is sent to, the Azure model
 * lists name only models the merged groups serve, and Azure assistants none of those supports
 * are turned off (`withServedAzureModels`). What AppService derives from the parts layers wrote
 * is derived again (`rederiveMergedConfig`): custom endpoint parameters (with
 * `expandCustomEndpoint`), the agents endpoint's memory capability, and with `rederiveEndpoints`
 * the Azure groups, Vertex AI and the Azure Assistants endpoint.
 */
export function mergeConfigOverrides(
  baseConfig: AppConfig,
  configs: readonly ConfigOverrideLayer[],
  options: MergeConfigOverridesOptions = {},
): AppConfig {
  return mergeConfigOverridesWithSource(baseConfig, configs, options).appConfig;
}

/**
 * {@link mergeConfigOverrides}, with the librechat.yaml-shaped config the layers merge to, from
 * which a caller derives what only the final config decides (such as the interface defaults
 * model specs turn off, once tenant scoping has settled which specs are served).
 */
export function mergeConfigOverridesWithSource(
  baseConfig: AppConfig,
  configs: readonly ConfigOverrideLayer[],
  options: MergeConfigOverridesOptions = {},
): ConfigMergeResult {
  if (!configs || configs.length === 0) {
    return { appConfig: baseConfig, raw: baseConfig.config ?? {} };
  }
  return mergeLayers(baseConfig, configs, options);
}

/**
 * {@link mergeConfigOverrides}, and what it amounts to in librechat.yaml shape: `resolved` is
 * `baseConfig.config` (the raw librechat.yaml) with each layer's tombstones and overrides folded
 * in under the merge's own rules (precedence, merge keys, atomic paths, accepted, base-only and
 * Base-only sections, invalid-override stripping, process MCP servers, the interface permission
 * filter), followed by the steps the served config takes after the fold: Azure model lists the
 * merged groups do not serve, web search keys withheld from a URL another layer decides, runtime
 * stops and base-only fields. Each layer lists what of it the merge does not apply as written.
 *
 * Not replayed, because they are AppService derivations librechat.yaml never holds: the fields
 * Azure `groups` resolve to (`groupMap`, `modelNames`, ...; `resolved` keeps the `groups`), what
 * `rederiveMergedConfig` derives again (expanded custom parameters, Vertex AI, the agents
 * capabilities, the Azure Assistants endpoint, and the model specs whose endpoint the layers
 * leave), and the `afterLayer` policy a caller adds (the admin API replays its secret rebinding
 * itself).
 */
export function resolveConfigLayers(
  baseConfig: AppConfig,
  configs: readonly ConfigOverrideLayer[],
  options: MergeConfigOverridesOptions = {},
): ConfigLayersResolution {
  const tracker: FoldTracker = {
    resolved: toAppConfigKeys(baseConfig.config ?? {}),
    layers: [],
  };
  if (!configs || configs.length === 0) {
    return {
      merged: baseConfig,
      raw: baseConfig.config ?? {},
      resolved: toOverrideKeys(tracker.resolved),
      layers: [],
    };
  }
  const { appConfig: merged, raw } = mergeLayers(baseConfig, configs, options, tracker);
  return {
    merged,
    raw,
    resolved: toOverrideKeys(tracker.resolved),
    layers: tracker.layers.map(({ layer, ignored }) => ({ layer, ignored })),
  };
}

/**
 * The YAML-shaped config `configs` resolve to on top of `baseYaml`: exactly the value
 * {@link mergeConfigOverrides} validates the next layer on, with the same precedence order,
 * tombstones, base-only and dedicated-section filtering, invalid-override stripping and
 * process-MCP filtering. It is a validation floor, not the served config (no AppService
 * derivation runs on it).
 */
export function resolveRawConfig(
  baseYaml: Partial<TCustomConfig>,
  configs: readonly ConfigOverrideLayer[],
  derivation: ConfigDerivation = {},
): Partial<TCustomConfig> {
  if (configs.length === 0) {
    return baseYaml;
  }
  /** AppService serves `mcpServers` as `mcpConfig` unchanged (or `null`), and the fold reads it there. */
  return foldConfigLayers(
    { mcpConfig: baseYaml.mcpServers ?? null },
    baseYaml,
    configs,
    undefined,
    derivation,
  ).raw;
}

/**
 * What the merge leaves out of `layer`'s stored overrides and tombstones, each at its own
 * location: the parts no merge applies (unknown, base-only and dedicated sections, interface
 * permissions, MCP servers librechat.yaml runs as processes), the values it sets back to
 * librechat.yaml's (base-only and deployment-only fields), and the values that fail validation
 * where it applies them. Judged exactly as the merge folds the layer over `baseYaml`
 * (librechat.yaml) and the layers in `below` (those that merge first, such as the active Base),
 * through the same steps. A field below a tombstone counts as put back when librechat.yaml sets
 * it or `resolved`, the AppConfig librechat.yaml resolves to, holds it (defaults included), with
 * the checks `derivation` adds (`getConfigOverrideIssues`). Each location is listed once per
 * reason and kind; nothing about a value is returned.
 */
export function getIgnoredConfigOverrides(
  baseYaml: Partial<TCustomConfig>,
  layer: ConfigOverrideLayer,
  below: readonly ConfigOverrideLayer[] = [],
  resolved?: AppConfig,
  derivation: ConfigDerivation = {},
): AdminConfigIgnoredOverride[] {
  const found = new Map<string, AdminConfigIgnoredOverride>();
  foldConfigLayers(
    { mcpConfig: baseYaml.mcpServers ?? null },
    baseYaml,
    [...below, layer],
    undefined,
    derivation,
    {
      sink: (source, entry) => {
        const key = JSON.stringify([entry.kind, entry.reason, entry.segments]);
        if (source === layer && !found.has(key)) {
          found.set(key, entry);
        }
      },
      isHeldValueSet: (held) =>
        getPath(baseYaml, [...held.segments]) !== undefined ||
        (resolved != null &&
          getPath(resolved, remapOverridePath(held.segments.join('.')).split('.')) !== undefined),
    },
  );
  return [...found.values()];
}

function getPath(target: unknown, segments: string[]): unknown {
  let current = target;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Puts back the base value of every field only librechat.yaml sets (`YAML_HELD_PATHS`: the
 * base-only and deployment-only paths), whatever an override set or a tombstone removed on the
 * way, so every reader of the merged config sees the operator's value.
 */
function preserveBaseOnlyPaths<T extends AppConfig>(baseConfig: AppConfig, merged: T): T {
  let result: unknown = merged;
  for (const held of YAML_HELD_PATHS) {
    const segments = remapOverridePath(held.segments.join('.')).split('.');
    const value = getPath(baseConfig, segments);
    if (getPath(result, segments) !== value) result = setPath(result, segments, value);
  }
  return result as T;
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
 * precedence order into an ACCUMULATED value, so a guard there compares against whatever
 * the previous override left — which let an EARLIER `false` block a LATER `true` and broke
 * last-layer-wins. Overrides still order normally among themselves; only the base stop is
 * non-negotiable.
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
