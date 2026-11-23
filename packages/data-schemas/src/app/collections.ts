import { normalizeEndpointName } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { ConfigEntryStep, ConfigLocation, ConfigPathSegments } from './paths';
import type { AppConfig } from '~/types';
import { parseFieldPath, isSegmentPrefix, parseConfigPath } from './paths';

/**
 * Arrays of config entries merged by a key field, and how entries of one are addressed.
 *
 * Paths here use AppConfig key names (after `OVERRIDE_KEY_MAP` remapping), not YAML-level key
 * names: `interfaceConfig.x`, not `interface.x`. Functions that take override (YAML) segments
 * remap them first.
 */

/**
 * Paths within the config tree where arrays of objects should be merged by a key field rather
 * than replaced wholesale. The merge matches items by the given key, deep-merges matching pairs,
 * preserves unmatched base items, and appends new override-only items.
 */
export const ARRAY_MERGE_KEYS: Readonly<Record<string, string>> = {
  'endpoints.custom': 'name',
  'endpoints.azureOpenAI.groups': 'group',
};

/**
 * How a merge key is folded before items are matched, by `ARRAY_MERGE_KEYS` path: two
 * spellings the runtime serves as one item are one item to the merge too. Custom endpoint
 * names fold through `normalizeEndpointName`, so an override `ollama` lands on the YAML
 * `Ollama` instead of serving beside it with a different baseURL and key.
 */
export const MERGE_KEY_FOLDS: Readonly<Record<string, (key: string) => string>> = {
  'endpoints.custom': normalizeEndpointName,
};

/**
 * Maps YAML-level override keys (TCustomConfig) to their AppConfig equivalents. Overrides are
 * stored with YAML keys but merged into the already-processed AppConfig, where AppService
 * renamed some fields. When AppService renames a field, add the mapping here; entries are
 * type-checked (keys are TCustomConfig fields, values AppConfig fields).
 */
export const OVERRIDE_KEY_MAP: Readonly<Partial<Record<keyof TCustomConfig, keyof AppConfig>>> = {
  mcpServers: 'mcpConfig',
  interface: 'interfaceConfig',
  turnstile: 'turnstileConfig',
};

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** An override (YAML) dot-path under AppConfig section names. */
export function remapOverridePath(path: string): string {
  const [first, ...rest] = path.split('.');
  const mappedFirst = OVERRIDE_KEY_MAP[first as keyof typeof OVERRIDE_KEY_MAP] ?? first;
  return [mappedFirst, ...rest].join('.');
}

/** The `ARRAY_MERGE_KEYS` path of the merged-by-key array at an override (YAML) path. */
export function getConfigMergeArrayPath(segments: readonly string[]): string | undefined {
  if (segments.length === 0 || segments.some((segment) => segment.includes('.'))) {
    return undefined;
  }
  const appConfigPath = remapOverridePath(segments.join('.'));
  return hasOwn(ARRAY_MERGE_KEYS, appConfigPath) ? appConfigPath : undefined;
}

/**
 * The key field that identifies entries of the merged-by-key array at an override (YAML) path,
 * such as `name` for `endpoints.custom`; `undefined` for any other path.
 */
export function getConfigArrayMergeKey(segments: readonly string[]): string | undefined {
  const arrayPath = getConfigMergeArrayPath(segments);
  return arrayPath === undefined ? undefined : ARRAY_MERGE_KEYS[arrayPath];
}

/**
 * Folds a merge key of the merged-by-key array at `arrayPath` into the identity layers match
 * on (`Ollama` and `ollama` are one custom endpoint); other keys come back unchanged. Code that
 * pairs items across writes, such as secret preservation, matches on the same identity.
 */
export function foldConfigMergeKey(arrayPath: string, key: string): string {
  return hasOwn(MERGE_KEY_FOLDS, arrayPath) ? MERGE_KEY_FOLDS[arrayPath](key) : key;
}

/**
 * The identity entry key `key` of the merged-by-key array at an override (YAML) path has: the
 * key as the runtime merge folds it (`foldConfigMergeKey`), so `Ollama` and `ollama` name one
 * custom endpoint to entry changes as they do to the merge. A key at any other path is its own
 * identity.
 */
export function getConfigEntryIdentity(segments: readonly string[], key: string): string {
  const arrayPath = getConfigMergeArrayPath(segments);
  return arrayPath === undefined ? key : foldConfigMergeKey(arrayPath, key);
}

/** A keyed location whose array is merged by key, with its key field and the key's identity. */
export interface ConfigEntryLocation {
  segments: ConfigPathSegments;
  entry: ConfigEntryStep;
  keyField: string;
  identity: string;
}

/**
 * A keyed location ({@link ConfigLocation} with `entry`) whose array is merged by key, or
 * `null` for any other location: an unkeyed path, or a key step after an array the merge
 * replaces, which no entry can be matched in.
 */
export function toConfigEntryLocation(location: ConfigLocation): ConfigEntryLocation | null {
  if (!location.entry) {
    return null;
  }
  const keyField = getConfigArrayMergeKey(location.segments);
  if (!keyField) {
    return null;
  }
  return {
    segments: location.segments,
    entry: location.entry,
    keyField,
    identity: getConfigEntryIdentity(location.segments, location.entry.key),
  };
}

/** A stored tombstone as an entry location, or `null` when it is not a keyed tombstone the merge applies. */
export function readConfigEntryTombstone(tombstone: string): ConfigEntryLocation | null {
  const location = parseConfigPath(tombstone);
  return location ? toConfigEntryLocation(location) : null;
}

/** Whether `item` is an entry of the array at `location` with the key `location` names. */
export function isConfigEntryAt(location: ConfigEntryLocation, item: unknown): boolean {
  if (item == null || typeof item !== 'object' || Array.isArray(item)) {
    return false;
  }
  const key = (item as Record<string, unknown>)[location.keyField];
  return (
    typeof key === 'string' && getConfigEntryIdentity(location.segments, key) === location.identity
  );
}

/**
 * The segments a stored tombstone names, for comparing it with a path: a keyed tombstone of an
 * array merged by key by its array's segments, so a path at or above the array covers it
 * whatever its key. Any other one is split on its dots, as it was stored, so a tombstone stored
 * before keyed paths existed (a record key such as an MCP server named `a["b"]`) keeps its
 * meaning.
 */
export function getConfigTombstoneSegments(tombstone: string): ConfigPathSegments {
  return readConfigEntryTombstone(tombstone)?.segments ?? parseFieldPath(tombstone);
}

function isSameArray(left: ConfigPathSegments, right: ConfigPathSegments): boolean {
  return left.length === right.length && isSegmentPrefix(left, right);
}

/**
 * Whether stored tombstone `tombstone` is at or below `location`: for a dotted location, the
 * plain tombstones below it and every keyed one under an array at or below it; for a keyed
 * location, the keyed tombstones of the same entry (by identity, so `ollama` covers `Ollama`)
 * whose path inside the entry is at or below its own.
 */
export function isConfigTombstoneAtOrBelow(tombstone: string, location: ConfigLocation): boolean {
  const target = toConfigEntryLocation(location);
  if (!target) {
    return (
      !location.entry && isSegmentPrefix(location.segments, getConfigTombstoneSegments(tombstone))
    );
  }
  const stored = readConfigEntryTombstone(tombstone);
  return (
    stored != null &&
    stored.identity === target.identity &&
    isSameArray(stored.segments, target.segments) &&
    isSegmentPrefix(target.entry.rest, stored.entry.rest)
  );
}

/** Whether `tombstone` hides the whole entry `key` of the merged-by-key array at `segments`. */
export function isConfigEntryTombstone(
  tombstone: string,
  segments: ConfigPathSegments,
  key: string,
): boolean {
  const stored = readConfigEntryTombstone(tombstone);
  return (
    stored != null &&
    stored.entry.rest.length === 0 &&
    isSameArray(stored.segments, segments) &&
    stored.identity === getConfigEntryIdentity(segments, key)
  );
}

/** The override (YAML) segments of every array merged by key. */
export function getConfigMergeArrays(): string[][] {
  return Object.keys(ARRAY_MERGE_KEYS).map((path) => {
    const [first, ...rest] = path.split('.');
    const section = Object.entries(OVERRIDE_KEY_MAP).find(([, appKey]) => appKey === first)?.[0];
    return [section ?? first, ...rest];
  });
}
