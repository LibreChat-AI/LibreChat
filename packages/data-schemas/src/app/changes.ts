import type { TCustomConfig } from 'librechat-data-provider';
import type { ConfigEntryStep, ConfigPathSegments } from './paths';
import type { ConfigOverrideState } from './mutations';
import {
  setConfigFields,
  unsetConfigPaths,
  tombstoneConfigPaths,
  getPathClearedTombstones,
  getWriteClearedTombstones,
  renameConfigEntryTombstones,
} from './mutations';
import {
  getAtPath,
  setAtPath,
  unsetAtPath,
  isPlainRecord,
  ConfigPathError,
  isSegmentPrefix,
  isConfigEntryKey,
  pruneEmptyAncestors,
} from './paths';
import {
  getConfigEntryIdentity,
  getConfigArrayMergeKey,
  isConfigEntryTombstone,
  getConfigTombstoneSegments,
} from './collections';
import { combineFoldedConfigEntries } from './resolution';

/**
 * Atomic batches of override changes.
 *
 * Every change is a pure transform of a principal's {@link ConfigOverrideState}, applied in
 * array order to the decoded document, so a batch is one read, any number of changes, and one
 * compare-and-swap write. Nothing here knows how a document is stored: an engine only ever
 * sees the finished document.
 *
 * Each transform returns its input state unchanged (the same object) when it changes nothing,
 * so a caller can tell an effective change from a no-op by identity.
 */

/**
 * The most changes one batch may carry. It is a fixed part of the admin API contract rather
 * than a `librechat.yaml` setting: clients split larger saves against it, so it is the same on
 * every deployment. The 3 MB JSON body limit bounds a batch's size; this bounds its work, since
 * each change is checked, has its secrets resolved and is applied in turn within one request.
 */
export const MAX_CONFIG_CHANGE_OPS = 1000;

export type ConfigChange =
  /** Writes `value` at the path and clears the tombstones the write covers. */
  | { op: 'set'; segments: ConfigPathSegments; value: unknown }
  /**
   * Removes the override at the path, its emptied parents, and tombstones at or below it. With
   * `entry`, `segments` is an array merged by key, and the change resets the principal's own
   * entry with that key (by identity), or the path inside it, and the keyed tombstones of that
   * entry at or below it.
   */
  | { op: 'unset'; segments: ConfigPathSegments; entry?: ConfigEntryStep }
  /**
   * Removes the override at the path and records a tombstone that hides inherited values. With
   * `entry`, it hides the inherited entry with that key of the merged-by-key array at
   * `segments`, or the path inside it, and removes the principal's own entry or that path.
   */
  | { op: 'tombstone'; segments: ConfigPathSegments; entry?: ConfigEntryStep }
  /**
   * Replaces the principal's own entry of a merged-by-key array whose key matches the entry's
   * (every own entry with that key), or appends it. The array is created when missing, and a
   * tombstone hiding that whole entry is cleared. Entry keys of every entry change match by
   * identity (`getConfigEntryMatcher`): `ollama` addresses a stored `Ollama`.
   */
  | { op: 'upsertEntry'; segments: ConfigPathSegments; entry: Record<string, unknown> }
  /** Removes the principal's own entries of a merged-by-key array that have this key. */
  | { op: 'removeEntry'; segments: ConfigPathSegments; key: string }
  /**
   * Renames one of the principal's own entries, moving everything stored on it (encrypted
   * secrets included): an entry of a merged-by-key array gets a new key value in place (one
   * stored in two spellings of its key is combined first, as the runtime merge combines it),
   * with the keyed tombstones of the old key moved to the new one, and a record key is moved
   * with its value, keeping the record's key order.
   */
  | { op: 'rename'; segments: ConfigPathSegments; from: string; to: string };

export type ConfigChangeKind = ConfigChange['op'];

/** Why an entry change cannot apply to the stored document. */
export type ConfigEntryErrorReason =
  /** The path holds neither a merged-by-key array nor (for a rename) an object. */
  | 'not_collection'
  /** The entry is not an object, or its key field is not a non-empty string. */
  | 'invalid_entry'
  /** A rename names an entry the principal does not have. */
  | 'entry_not_found'
  /** A rename's new key is already one of the principal's entries. */
  | 'entry_exists';

/**
 * An entry change that cannot apply to the document as stored. Like `ConfigPathError`, the
 * message never echoes submitted keys.
 */
export class ConfigEntryError extends Error {
  readonly code = 'CONFIG_ENTRY_INVALID';

  constructor(
    readonly segments: string[],
    readonly reason: ConfigEntryErrorReason,
  ) {
    super(`Config entry change cannot be applied: ${reason}`);
    this.name = 'ConfigEntryError';
  }
}

export function isConfigEntryError(error: unknown): error is ConfigEntryError {
  return (
    error instanceof ConfigEntryError ||
    (error instanceof Error && (error as { code?: unknown }).code === 'CONFIG_ENTRY_INVALID')
  );
}

type JsonRecord = { [key: string]: unknown };

/** Structural equality of JSON values; object key order does not matter. */
export function isSameConfigValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => isSameConfigValue(item, right[index]))
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    return false;
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        isSameConfigValue(left[key], right[key]),
    )
  );
}

function hasPath(root: unknown, segments: ConfigPathSegments): boolean {
  const parent = segments.length > 1 ? getAtPath(root, segments.slice(0, -1)) : root;
  const key = segments[segments.length - 1];
  if (Array.isArray(parent)) {
    return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < parent.length;
  }
  return isPlainRecord(parent) && Object.prototype.hasOwnProperty.call(parent, key);
}

function isSameState(left: ConfigOverrideState, right: ConfigOverrideState): boolean {
  return (
    left.overrides === right.overrides &&
    left.tombstones.length === right.tombstones.length &&
    left.tombstones.every((path, index) => path === right.tombstones[index])
  );
}

function asRecord(state: ConfigOverrideState): JsonRecord {
  return state.overrides as JsonRecord;
}

function withOverrides(state: ConfigOverrideState, overrides: JsonRecord): ConfigOverrideState {
  return { overrides: overrides as Partial<TCustomConfig>, tombstones: state.tombstones };
}

function applySet(
  state: ConfigOverrideState,
  segments: ConfigPathSegments,
  value: unknown,
): ConfigOverrideState {
  const unchanged =
    hasPath(state.overrides, segments) &&
    isSameConfigValue(getAtPath(state.overrides, segments), value) &&
    getWriteClearedTombstones(state.tombstones, segments, value).length === 0;
  return unchanged ? state : setConfigFields(state, [{ segments, value }]);
}

function keepIfSame(state: ConfigOverrideState, next: ConfigOverrideState): ConfigOverrideState {
  return isSameState(state, next) ? state : next;
}

/** The principal's own array at a merged-by-key path, `[]` when it has none. */
function readKeyedArray(state: ConfigOverrideState, segments: ConfigPathSegments): unknown[] {
  const current = getAtPath(state.overrides, segments);
  if (current === undefined) {
    return [];
  }
  if (!Array.isArray(current)) {
    throw new ConfigEntryError([...segments], 'not_collection');
  }
  return current;
}

function requireKeyField(segments: ConfigPathSegments): string {
  const keyField = getConfigArrayMergeKey(segments);
  if (!keyField) {
    throw new ConfigEntryError([...segments], 'not_collection');
  }
  return keyField;
}

/**
 * A test for the entries of the merged-by-key array at `segments` that key `key` names. Keys
 * compare by identity (`getConfigEntryIdentity`), so `Ollama` and `ollama` address the one
 * custom endpoint the runtime merge makes of them.
 */
export function getConfigEntryMatcher(
  segments: ConfigPathSegments,
  keyField: string,
  key: string,
): (item: unknown) => boolean {
  const identity = getConfigEntryIdentity(segments, key);
  return (item) => {
    const itemKey = isPlainRecord(item) ? item[keyField] : undefined;
    return typeof itemKey === 'string' && getConfigEntryIdentity(segments, itemKey) === identity;
  };
}

/** The key of an entry written into a merged-by-key array. */
export function getConfigEntryKey(entry: unknown, keyField: string): string | undefined {
  if (!isPlainRecord(entry)) {
    return undefined;
  }
  const key = entry[keyField];
  return typeof key === 'string' && key !== '' ? key : undefined;
}

/** Writes `items` back at `segments`, removing the array (and emptied parents) once empty. */
function writeKeyedArray(
  state: ConfigOverrideState,
  segments: ConfigPathSegments,
  items: unknown[],
): ConfigOverrideState {
  if (items.length > 0) {
    return withOverrides(state, setAtPath(asRecord(state), segments, items));
  }
  const removed = unsetAtPath(asRecord(state), segments);
  return withOverrides(state, pruneEmptyAncestors(removed, segments));
}

function applyUpsertEntry(
  state: ConfigOverrideState,
  segments: ConfigPathSegments,
  entry: Record<string, unknown>,
): ConfigOverrideState {
  const keyField = requireKeyField(segments);
  const key = getConfigEntryKey(entry, keyField);
  if (key === undefined) {
    throw new ConfigEntryError([...segments], 'invalid_entry');
  }
  const items = readKeyedArray(state, segments);
  const isEntry = getConfigEntryMatcher(segments, keyField, key);
  const index = items.findIndex(isEntry);
  const next =
    index === -1
      ? [...items, entry]
      : items.flatMap((item, position) => {
          if (position === index) {
            return [entry];
          }
          return isEntry(item) ? [] : [item];
        });
  const tombstones = state.tombstones.filter(
    (tombstone) => !isConfigEntryTombstone(tombstone, segments, key),
  );
  if (isSameConfigValue(items, next) && tombstones.length === state.tombstones.length) {
    return state;
  }
  return writeKeyedArray({ overrides: state.overrides, tombstones }, segments, next);
}

function applyRemoveEntry(
  state: ConfigOverrideState,
  segments: ConfigPathSegments,
  key: string,
): ConfigOverrideState {
  const keyField = requireKeyField(segments);
  const items = readKeyedArray(state, segments);
  const isEntry = getConfigEntryMatcher(segments, keyField, key);
  const next = items.filter((item) => !isEntry(item));
  return next.length === items.length ? state : writeKeyedArray(state, segments, next);
}

function renameKeyedEntry(
  state: ConfigOverrideState,
  segments: ConfigPathSegments,
  keyField: string,
  from: string,
  to: string,
): ConfigOverrideState {
  const items = readKeyedArray(state, segments);
  const isFrom = getConfigEntryMatcher(segments, keyField, from);
  const index = items.findIndex(isFrom);
  if (index === -1) {
    throw new ConfigEntryError([...segments], 'entry_not_found');
  }
  const isTo = getConfigEntryMatcher(segments, keyField, to);
  if (items.some((item) => isTo(item) && !isFrom(item))) {
    throw new ConfigEntryError([...segments], 'entry_exists');
  }
  const renamed = (item: unknown): JsonRecord => ({ ...(item as JsonRecord), [keyField]: to });
  /** One entry stored in two spellings moves as the single entry the runtime merge combines. */
  const combined = combineFoldedConfigEntries(segments, items.filter(isFrom));
  const next = items.flatMap((item, position) => {
    if (!isFrom(item)) {
      return [item];
    }
    if (combined.length > 1) {
      return [renamed(item)];
    }
    return position === index ? [renamed(combined[0])] : [];
  });
  return renameConfigEntryTombstones(writeKeyedArray(state, segments, next), segments, from, to);
}

/** Moves record key `from` to `to`, keeping the key order. */
function renameRecordKey(
  state: ConfigOverrideState,
  segments: ConfigPathSegments,
  from: string,
  to: string,
): ConfigOverrideState {
  const record = getAtPath(state.overrides, segments);
  if (record !== undefined && !isPlainRecord(record)) {
    throw new ConfigEntryError([...segments], 'not_collection');
  }
  if (!record || !Object.prototype.hasOwnProperty.call(record, from)) {
    throw new ConfigEntryError([...segments], 'entry_not_found');
  }
  if (Object.prototype.hasOwnProperty.call(record, to)) {
    throw new ConfigEntryError([...segments], 'entry_exists');
  }
  const renamed: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    /** Defined rather than assigned, so a `__proto__` key stays data. */
    Object.defineProperty(renamed, key === from ? to : key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const cleared = new Set(getPathClearedTombstones([...segments, to]));
  return {
    overrides: setAtPath(asRecord(state), segments, renamed) as Partial<TCustomConfig>,
    tombstones: state.tombstones.filter((path) => !cleared.has(path)),
  };
}

function applyRename(
  state: ConfigOverrideState,
  segments: ConfigPathSegments,
  from: string,
  to: string,
): ConfigOverrideState {
  if (from === to) {
    return state;
  }
  if (from === '' || to === '') {
    throw new ConfigEntryError([...segments], 'invalid_entry');
  }
  const keyField = getConfigArrayMergeKey(segments);
  if (!keyField) {
    return renameRecordKey(state, segments, from, to);
  }
  if (!isConfigEntryKey(to)) {
    throw new ConfigEntryError([...segments], 'invalid_entry');
  }
  return renameKeyedEntry(state, segments, keyField, from, to);
}

/**
 * Applies one change. A path the document cannot take throws a `ConfigPathError`; an entry
 * change that cannot apply throws a {@link ConfigEntryError}. Returns `state` itself when the
 * change leaves the document as it was.
 */
export function applyConfigChange(
  state: ConfigOverrideState,
  change: ConfigChange,
): ConfigOverrideState {
  if (change.segments.length === 0) {
    throw new ConfigPathError([], 'empty_path');
  }
  switch (change.op) {
    case 'set':
      return applySet(state, change.segments, change.value);
    case 'unset':
      return keepIfSame(
        state,
        unsetConfigPaths(state, [{ segments: change.segments, entry: change.entry }]),
      );
    case 'tombstone':
      return keepIfSame(
        state,
        tombstoneConfigPaths(state, [{ segments: change.segments, entry: change.entry }]),
      );
    case 'upsertEntry':
      return applyUpsertEntry(state, change.segments, change.entry);
    case 'removeEntry':
      return applyRemoveEntry(state, change.segments, change.key);
    case 'rename':
      return applyRename(state, change.segments, change.from, change.to);
    default: {
      const unknownChange: never = change;
      throw new Error(`Unknown config change: ${String((unknownChange as ConfigChange).op)}`);
    }
  }
}

/** The result of {@link applyConfigChanges}: the final state, and which changes had an effect. */
export interface ConfigChangesResult {
  state: ConfigOverrideState;
  /** `changed[i]` is whether change `i` altered the document it was applied to. */
  changed: boolean[];
}

/**
 * Applies changes in array order, each to the result of the one before, exactly as the same
 * changes sent one request at a time would. Throws on the first change that cannot apply,
 * leaving the input untouched.
 */
export function applyConfigChanges(
  state: ConfigOverrideState,
  changes: readonly ConfigChange[],
): ConfigChangesResult {
  const changed: boolean[] = [];
  let current = state;
  for (const change of changes) {
    const next = applyConfigChange(current, change);
    changed.push(next !== current);
    current = next;
  }
  return { state: current, changed };
}

/**
 * A step of a location named by identity rather than position: a key (or a position in an array
 * that is not merged by key), or an entry of a merged-by-key array by its merge key.
 */
export type ConfigIdentityStep = string | { readonly entry: string };

/**
 * `segments` as `root` holds them, by identity: a position in a merged-by-key array becomes the
 * key of the entry there, so the location still names that entry once other entries come and go.
 * A position whose item has no key stays a position.
 */
export function toConfigIdentityPath(
  root: unknown,
  segments: ConfigPathSegments,
): ConfigIdentityStep[] {
  return segments.map((segment, index): ConfigIdentityStep => {
    const parent = segments.slice(0, index);
    const keyField = getConfigArrayMergeKey(parent);
    const items = keyField ? getAtPath(root, parent) : undefined;
    const key =
      keyField && Array.isArray(items)
        ? getConfigEntryKey(items[Number(segment)], keyField)
        : undefined;
    return key !== undefined ? { entry: key } : segment;
  });
}

/**
 * Where an identity path ({@link toConfigIdentityPath}) is in `root`: each entry of a
 * merged-by-key array by its position there. `null` when an entry it passes through is gone.
 */
export function resolveConfigIdentityPath(
  root: unknown,
  path: readonly ConfigIdentityStep[],
): string[] | null {
  const segments: string[] = [];
  for (const step of path) {
    if (typeof step === 'string') {
      segments.push(step);
      continue;
    }
    const keyField = getConfigArrayMergeKey(segments);
    const items = getAtPath(root, segments);
    const index =
      keyField && Array.isArray(items)
        ? items.findIndex(getConfigEntryMatcher(segments, keyField, step.entry))
        : -1;
    if (index === -1) {
      return null;
    }
    segments.push(String(index));
  }
  return segments;
}

/**
 * An identity path once a `rename` of the collection at `collection` has moved the record key, or
 * renamed the merged-by-key entry, the path passes through from `from` to `to`.
 */
export function renameConfigIdentityPath(
  path: readonly ConfigIdentityStep[],
  collection: ConfigPathSegments,
  from: string,
  to: string,
): ConfigIdentityStep[] {
  const step = path[collection.length];
  if (step === undefined || !collection.every((segment, index) => path[index] === segment)) {
    return [...path];
  }
  const keyed = getConfigArrayMergeKey(collection) !== undefined;
  const renamed = keyed
    ? typeof step !== 'string' &&
      getConfigEntryIdentity(collection, step.entry) === getConfigEntryIdentity(collection, from)
    : step === from;
  if (!renamed) {
    return [...path];
  }
  const next = [...path];
  next[collection.length] = keyed ? { entry: to } : to;
  return next;
}

/**
 * Where a keyed change leaves the principal's own entry with key `key`: the entry by its index
 * in `result`, or nothing once the change removed it (hiding or resetting it whole, or emptying
 * it down to its key).
 */
function getEntryWrittenPaths(
  segments: ConfigPathSegments,
  key: string,
  result: ConfigOverrideState,
): string[][] {
  const keyField = getConfigArrayMergeKey(segments);
  const items = getAtPath(result.overrides, segments);
  const index =
    keyField && Array.isArray(items)
      ? items.findIndex(getConfigEntryMatcher(segments, keyField, key))
      : -1;
  return index === -1 ? [] : [[...segments, String(index)]];
}

/**
 * The paths a change writes, for attributing validation issues to it: the path itself, or for
 * an entry change, the entry by its index in `result`'s own array. A removed entry is gone, so
 * `removeEntry` writes nothing an issue could sit on: the entries it leaves are unchanged, and
 * their existing issues must not block the removal. Likewise an entry `result` no longer holds
 * (a later change of the batch renamed it back) leaves nothing written behind.
 */
export function getConfigChangeWrittenPaths(
  change: ConfigChange,
  result: ConfigOverrideState,
): string[][] {
  const segments = [...change.segments];
  if ((change.op === 'unset' || change.op === 'tombstone') && change.entry) {
    return getEntryWrittenPaths(change.segments, change.entry.key, result);
  }
  if (change.op === 'set' || change.op === 'unset' || change.op === 'tombstone') {
    return [segments];
  }
  if (change.op === 'removeEntry') {
    return [];
  }
  const keyField = getConfigArrayMergeKey(change.segments);
  if (change.op === 'rename' && !keyField) {
    return [
      [...segments, change.from],
      [...segments, change.to],
    ];
  }
  const key =
    change.op === 'rename' ? change.to : keyField && getConfigEntryKey(change.entry, keyField);
  const items = getAtPath(result.overrides, segments);
  const index =
    Array.isArray(items) && keyField && key
      ? items.findIndex(getConfigEntryMatcher(change.segments, keyField, key))
      : -1;
  return index === -1 ? [] : [[...segments, String(index)]];
}

/**
 * The value `stored` holds at the location `segments` names in `result`: an entry of a
 * merged-by-key array is the stored entry with the same key, wherever it sits.
 */
function getStoredCounterpart(
  segments: ConfigPathSegments,
  result: unknown,
  stored: unknown,
): unknown {
  let current = result;
  let counterpart = stored;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const next = getAtPath(current, [segment]);
    const keyField = Array.isArray(current)
      ? getConfigArrayMergeKey(segments.slice(0, index))
      : undefined;
    const key = keyField ? getConfigEntryKey(next, keyField) : undefined;
    if (keyField && key !== undefined) {
      counterpart = Array.isArray(counterpart)
        ? counterpart.find(getConfigEntryMatcher(segments.slice(0, index), keyField, key))
        : undefined;
    } else {
      counterpart = getAtPath(counterpart, [segment]);
    }
    current = next;
  }
  return counterpart;
}

/**
 * The tombstones at, above or below `segments`: the ones that decide what it inherits. A keyed
 * tombstone counts by its array, so any change to the entries it hides relates to the array.
 */
function getRelatedTombstones(
  tombstones: readonly string[],
  segments: ConfigPathSegments,
): Set<string> {
  return new Set(
    tombstones.filter((path) => {
      const tombstone = getConfigTombstoneSegments(path);
      return isSegmentPrefix(tombstone, segments) || isSegmentPrefix(segments, tombstone);
    }),
  );
}

/** Whether `result` holds the location `segments` names there other than `stored` does. */
function isChangedLocation(
  segments: ConfigPathSegments,
  result: ConfigOverrideState,
  stored: ConfigOverrideState,
): boolean {
  const value = getAtPath(result.overrides, segments);
  if (
    !isSameConfigValue(value, getStoredCounterpart(segments, result.overrides, stored.overrides))
  ) {
    return true;
  }
  const before = getRelatedTombstones(stored.tombstones, segments);
  const after = getRelatedTombstones(result.tombstones, segments);
  return before.size !== after.size || [...after].some((path) => !before.has(path));
}

/**
 * The paths a batch writes, judged on its end state, for attributing validation issues to it.
 * Each change's paths ({@link getConfigChangeWrittenPaths}) are located in `result`, the state
 * after the whole batch, so an entry a later change moves is still named by where it ends up.
 * Only the paths `result` holds differently from `stored` are kept: a change a later one undoes
 * (set a field, then restore its parent) writes nothing in the end, so issues the stored
 * document already had there are left to merge time instead of blocking the rest of the batch.
 */
export function getConfigBatchWrittenPaths(
  changes: readonly ConfigChange[],
  result: ConfigOverrideState,
  stored: ConfigOverrideState,
): string[][] {
  return changes.flatMap((change) =>
    getConfigChangeWrittenPaths(change, result).filter((segments) =>
      isChangedLocation(segments, result, stored),
    ),
  );
}
