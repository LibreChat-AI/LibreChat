import {
  BASE_PRINCIPAL_CONFIG_SECTIONS,
  BASE_ONLY_CONFIG_SECTIONS,
  INTERFACE_PERMISSION_FIELDS,
  RUNTIME_CONFIG_INTERFACE_FIELDS,
  PERMISSION_SUB_KEYS,
  isProcessMCPServerConfig,
  configSchema,
} from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { AppConfig, IConfig } from '~/types';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import { getTombstonePathsToClear } from '~/methods/config';
import logger from '~/config/winston';

type AnyObject = { [key: string]: unknown };

const MAX_MERGE_DEPTH = 10;
const MAX_STRIP_PASSES = 16;
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

export type ConfigOverrideIssue = {
  /** Dot-path of the override node the issue is attributed to, in YAML (`TCustomConfig`) keys. */
  path: string;
  /** The same location as keys, unambiguous when a record key itself contains a dot. */
  segments: string[];
  /**
   * A stable, machine-readable reason: a zod issue code (`invalid_type`, `custom`, ...),
   * `missing_merge_key`, `duplicate_merge_key`, `indexed_merge_key_write`, `union_dropped_key`, or `invalid_document`. Schema messages are not carried because
   * they can echo the submitted values.
   */
  code: string;
};

type IssuePath = Array<string | number>;

function isPlainObject(value: unknown): value is AnyObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function toIssue(segments: string[], code: string): ConfigOverrideIssue {
  return { path: segments.join('.'), segments, code };
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
): number {
  if (keyField) {
    for (let index = node.length - 1; index >= 0; index--) {
      const item = node[index];
      if (
        isPlainObject(item) &&
        isPlainObject(mergedItem) &&
        item[keyField] === mergedItem[keyField]
      ) {
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
      const index = findItemIndex(node, key, keyField, mergedItem);
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
    node.forEach((item, index) => isPlainObject(item) && lastIndex.set(item[keyField], index));
    return node.flatMap((item, index) => {
      if (!isPlainObject(item) || typeof item[keyField] !== 'string' || item[keyField] === '') {
        return [toIssue([...segments, String(index)], 'missing_merge_key')];
      }
      return lastIndex.get(item[keyField]) === index
        ? []
        : [toIssue([...segments, String(index)], 'duplicate_merge_key')];
    });
  });
}

type SchemaIssue = NonNullable<
  ReturnType<typeof configSchema.safeParse>['error']
>['issues'][number];

/**
 * A union reports one issue at its own path; the branch whose failures are fewest, then
 * deepest, is the shape the value was written for, so its issues locate the actual fault.
 */
function expandUnionIssues(issues: SchemaIssue[], depth = 0): SchemaIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code !== 'invalid_union' || depth >= MAX_MERGE_DEPTH) {
      return [issue];
    }
    const branches = issue.unionErrors.map((error) => error.issues);
    const closest = branches.reduce<SchemaIssue[] | undefined>((best, branch) => {
      if (!best || branch.length < best.length) {
        return branch;
      }
      const depthOf = (list: SchemaIssue[]) => Math.max(0, ...list.map((i) => i.path.length));
      return branch.length === best.length && depthOf(branch) > depthOf(best) ? branch : best;
    }, undefined);
    return closest && closest.length > 0 ? expandUnionIssues(closest, depth + 1) : [issue];
  });
}

/** The parts of a zod schema the stripped-key walk reads, without depending on zod. */
type SchemaNode = {
  _def: {
    typeName?: string;
    innerType?: SchemaNode;
    schema?: SchemaNode;
    type?: SchemaNode;
    valueType?: SchemaNode;
    options?: SchemaNode[] | Map<unknown, SchemaNode>;
  };
  shape?: Record<string, SchemaNode>;
  safeParse: (value: unknown) => { success: boolean };
};

/** The schema beneath optional, nullable, default and refinement wrappers. */
function unwrapSchema(schema: SchemaNode): SchemaNode {
  let node = schema;
  for (let depth = 0; depth < MAX_MERGE_DEPTH; depth++) {
    const inner = node._def.innerType ?? node._def.schema;
    if (!inner) {
      break;
    }
    node = inner;
  }
  return node;
}

/**
 * Keys a union dropped: an object parses with the first union option that accepts it, and
 * that option strips keys it does not define, so a key another option defines (and would
 * type-check) is kept raw in the stored override but never validated. Keys no option defines
 * are unknown keys and stay accepted.
 */
function findUnionDroppedKeys(
  schema: SchemaNode,
  value: unknown,
  path: IssuePath,
  depth = 0,
): IssuePath[] {
  if (depth >= MAX_MERGE_DEPTH) {
    return [];
  }
  const node = unwrapSchema(schema);
  const { typeName } = node._def;
  if (typeName === 'ZodObject' && node.shape && isPlainObject(value)) {
    const shape = node.shape;
    return Object.keys(value)
      .filter((key) => hasOwn(shape, key))
      .flatMap((key) => findUnionDroppedKeys(shape[key], value[key], [...path, key], depth + 1));
  }
  if (typeName === 'ZodArray' && node._def.type && Array.isArray(value)) {
    const item = node._def.type;
    return value.flatMap((entry, index) =>
      findUnionDroppedKeys(item, entry, [...path, index], depth + 1),
    );
  }
  if (typeName === 'ZodRecord' && node._def.valueType && isPlainObject(value)) {
    const entrySchema = node._def.valueType;
    return Object.entries(value).flatMap(([key, entry]) =>
      findUnionDroppedKeys(entrySchema, entry, [...path, key], depth + 1),
    );
  }
  if (
    (typeName !== 'ZodUnion' && typeName !== 'ZodDiscriminatedUnion') ||
    !node._def.options ||
    !isPlainObject(value)
  ) {
    return [];
  }
  const options = [...node._def.options.values()];
  const accepted = options.find((option) => option.safeParse(value).success);
  if (!accepted) {
    return [];
  }
  const acceptedShape = unwrapSchema(accepted).shape;
  const defined = new Set(
    options.flatMap((option) => Object.keys(unwrapSchema(option).shape ?? {})),
  );
  const dropped = acceptedShape
    ? Object.keys(value)
        .filter((key) => !hasOwn(acceptedShape, key) && defined.has(key))
        .map((key) => [...path, key])
    : [];
  return [...dropped, ...findUnionDroppedKeys(accepted, value, path, depth + 1)];
}

/**
 * Checks config overrides the way they apply: merged over `base` (YAML-shaped), each
 * section they touch parsed with its `configSchema` schema, and every failure attributed
 * to the override node that caused it. Unions, refinements, required fields and defaults
 * are therefore judged on the merged result, not on the patch alone. An issue caused only
 * by leaving something out (a required or related field another layer may supply) is not
 * reported, except inside an array the merge replaces, where nothing can supply it. Keys the schema does not define are accepted unchanged.
 */
export function getConfigOverrideIssues(
  overrides: unknown,
  base: Partial<TCustomConfig> = {},
): ConfigOverrideIssue[] {
  if (!isPlainObject(overrides)) {
    return [toIssue([], 'invalid_document')];
  }
  const merged = deepMerge(base as AnyObject, overrides);
  const issues = getMergeKeyIssues(overrides);
  const seen = new Set(issues.map((issue) => issue.path));
  const shape = configSchema.shape;
  for (const section of Object.keys(overrides)) {
    if (!hasOwn(shape, section)) {
      continue;
    }
    const schema = shape[section as keyof typeof shape] as unknown as SchemaNode;
    const result = shape[section as keyof typeof shape].safeParse(merged[section]);
    const dropped = findUnionDroppedKeys(schema, merged[section], []).map((path) => ({
      code: 'union_dropped_key',
      path,
    }));
    const schemaIssues = result.success ? [] : expandUnionIssues(result.error.issues);
    for (const issue of [...dropped, ...schemaIssues]) {
      if (issue.code === 'unrecognized_keys') {
        continue;
      }
      const issuePath: IssuePath = [section, ...issue.path];
      const segments = attributeIssue(overrides, merged, issuePath);
      if (
        !segments ||
        (segments.length < issuePath.length && !isReplacedArrayNode(overrides, segments))
      ) {
        continue;
      }
      const path = segments.join('.');
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      issues.push(toIssue(segments, issue.code));
    }
  }
  return issues;
}

/** Sets a dot-path the way a Mongo `$set` on `overrides.<path>` does, without mutating. */
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
    .reduce((current, path) => deletePath(current, path), base as AnyObject);
}

/**
 * Checks dot-path field writes on top of the principal's stored config, building the
 * result the way `patchConfigFields` stores it: a Mongo `$set` on each `overrides.<path>`,
 * clearing the tombstones those paths clear. The principal's remaining tombstones are
 * applied to the base. An issue is reported when it touches a written path, or when the
 * write introduced it elsewhere (a related field the write made invalid); issues the stored
 * config already had are left to merge time so they do not block an unrelated write.
 */
export function getConfigFieldIssues(
  fields: Record<string, unknown>,
  base: Partial<TCustomConfig> = {},
  stored?: { overrides?: unknown; tombstones?: unknown[] } | null,
): ConfigOverrideIssue[] {
  const written = Object.keys(fields).map((fieldPath) => fieldPath.split('.'));
  const cleared = new Set(Object.keys(fields).flatMap(getTombstonePathsToClear));
  const effectiveBase = applyConfigTombstones(base, stored?.tombstones, cleared);
  const storedOverrides = isPlainObject(stored?.overrides) ? stored.overrides : {};
  const candidate = Object.entries(fields).reduce<unknown>(
    (current, [fieldPath, value]) => setPath(current, fieldPath.split('.'), value),
    storedOverrides,
  );
  /**
   * An item of a merged-by-key array is identified by its key, not its position: an indexed
   * write can rename the stored item, which the runtime merge then treats as a new one.
   */
  const indexed = Object.keys(ARRAY_MERGE_KEYS).flatMap((arrayPath) => {
    const arraySegments = arrayPath.split('.');
    return written.some(
      (segments) =>
        segments.length > arraySegments.length && isRelatedPath(segments, arraySegments),
    )
      ? [toIssue(arraySegments, 'indexed_merge_key_write')]
      : [];
  });
  if (indexed.length > 0) {
    return indexed;
  }
  const existing = new Set(
    getConfigOverrideIssues(storedOverrides, effectiveBase).map((issue) => issue.path),
  );
  return getConfigOverrideIssues(candidate, effectiveBase).filter(
    (issue) =>
      !existing.has(issue.path) ||
      written.some((segments) => isRelatedPath(issue.segments, segments)),
  );
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
 * is not judged on what it leaves out, since a higher-priority layer may supply it.
 */
function stripInvalidOverrides(config: IConfig, base: Partial<TCustomConfig>): AnyObject {
  const principal = `${config.principalType}/${config.principalId}`;
  let stripped: unknown = config.overrides;
  /**
   * Removing a field can make a related field it supplies fail, so check again while
   * removals make progress. If they stop, only the sections that still fail are dropped.
   */
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const issues = getConfigOverrideIssues(stripped, base);
    if (issues.length === 0) {
      return stripped as AnyObject;
    }
    if (issues.some((issue) => issue.segments.length === 0)) {
      logger.warn(`[mergeConfigOverrides] Ignoring malformed overrides document for ${principal}`);
      return {};
    }
    const before = stripped;
    for (let index = issues.length - 1; index >= 0; index--) {
      const { path, segments, code } = issues[index];
      logger.warn(
        `[mergeConfigOverrides] Ignoring invalid override "${path}" for ${principal} (${code})`,
      );
      stripped = omitPath(stripped, segments);
    }
    if (stripped === before) {
      break;
    }
  }
  const failing = new Set(
    getConfigOverrideIssues(stripped, base).map((issue) => issue.segments[0]),
  );
  logger.warn(
    `[mergeConfigOverrides] Ignoring still-invalid sections ${[...failing].join(', ')} for ${principal}`,
  );
  return Object.fromEntries(
    Object.entries(stripped as AnyObject).filter(([section]) => !failing.has(section)),
  );
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
  /** The YAML-shaped config the next override lands on, for validating it in place. */
  let raw: Partial<TCustomConfig> = baseConfig.config ?? {};
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
          raw = deletePath(raw as AnyObject, path) as Partial<TCustomConfig>;
        }
      }
    }

    if (config.overrides && typeof config.overrides === 'object') {
      const remapped: AnyObject = {};
      const applied: AnyObject = {};
      for (const [key, value] of Object.entries(stripInvalidOverrides(config, raw))) {
        if (
          BASE_ONLY_OVERRIDE_SECTIONS.has(key) ||
          (!isBasePrincipal && BASE_PRINCIPAL_OVERRIDE_SECTIONS.has(key))
        ) {
          continue;
        }
        applied[key] = value;
        const mappedKey = OVERRIDE_KEY_MAP[key as keyof typeof OVERRIDE_KEY_MAP] ?? key;
        if (mappedKey === 'mcpConfig') {
          remapped[mappedKey] = filterMCPServerOverrides(
            value,
            (merged as unknown as AnyObject)[mappedKey],
          );
          /** A server the filter removed must not complete a later layer's partial of it. */
          applied[key] = remapped[mappedKey];
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
      raw = deepMerge(raw as AnyObject, applied) as Partial<TCustomConfig>;
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
