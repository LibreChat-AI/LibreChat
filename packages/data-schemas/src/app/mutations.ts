import type { TCustomConfig } from 'librechat-data-provider';
import type { ConfigLocation, ConfigPathSegments } from './paths';
import type { ConfigEntryLocation } from './collections';
import {
  getAtPath,
  setAtPath,
  unsetAtPath,
  isPlainRecord,
  isSegmentPrefix,
  formatKeyedPath,
  ConfigPathError,
  isEffectivelyEmpty,
  pruneEmptyAncestors,
  formatConfigLocation,
  getClearedTombstones,
  getKeyedLocationError,
} from './paths';
import {
  isConfigEntryAt,
  getConfigMergeArrays,
  toConfigEntryLocation,
  isConfigEntryTombstone,
  getConfigArrayMergeKey,
  getConfigEntryIdentity,
  readConfigEntryTombstone,
  isConfigTombstoneAtOrBelow,
} from './collections';

/**
 * The part of a principal's config document that override mutations change. Every mutation in
 * this module is a pure transform of it: the result is a new state, and the input is untouched.
 * Persisting the result is the store's job, in one compare-and-swap write.
 */
export interface ConfigOverrideState {
  overrides: Partial<TCustomConfig>;
  /** Dotted paths that suppress inherited values during resolution. */
  tombstones: string[];
}

/** One field written by {@link setConfigFields}. */
export interface ConfigFieldWrite {
  segments: ConfigPathSegments;
  value: unknown;
}

type JsonRecord = { [key: string]: unknown };

export const EMPTY_CONFIG_OVERRIDE_STATE: Readonly<ConfigOverrideState> = Object.freeze({
  overrides: {},
  tombstones: [],
});

/** The mutable part of a stored document, or the empty state when there is none. */
export function toConfigOverrideState(
  document?: { overrides?: unknown; tombstones?: unknown } | null,
): ConfigOverrideState {
  const overrides = isPlainRecord(document?.overrides) ? document.overrides : {};
  const tombstones = Array.isArray(document?.tombstones)
    ? document.tombstones.filter((path): path is string => typeof path === 'string')
    : [];
  return { overrides: overrides as Partial<TCustomConfig>, tombstones };
}

function asRecord(overrides: Partial<TCustomConfig>): JsonRecord {
  return overrides as JsonRecord;
}

/** A path a removal or tombstone lands on: its segments, or a location that may be keyed. */
export type ConfigRemoval = ConfigPathSegments | ConfigLocation;

function isLocation(removal: ConfigRemoval): removal is ConfigLocation {
  return !Array.isArray(removal);
}

function toLocation(removal: ConfigRemoval): ConfigLocation {
  return isLocation(removal) ? removal : { segments: removal };
}

/**
 * A keyed location whose array is merged by key and whose stored form names it exactly
 * (`getKeyedLocationError`); any other keyed location throws a `ConfigPathError`, so a
 * tombstone never names a different path from the one removed.
 */
function requireEntryLocation(location: ConfigLocation): ConfigEntryLocation {
  const reason = location.entry ? getKeyedLocationError(location.segments, location.entry) : null;
  if (reason) {
    throw new ConfigPathError([...location.segments], reason);
  }
  const entry = toConfigEntryLocation(location);
  if (!entry) {
    throw new ConfigPathError([...location.segments], 'keyed_path');
  }
  return entry;
}

/**
 * The entries a write of `value` at `segments` writes into arrays merged by key, by key: the
 * write is the array itself or one of its ancestors (`endpoints` holding `custom`).
 */
function getWrittenEntries(
  segments: ConfigPathSegments,
  value: unknown,
): Array<{ segments: string[]; key: string }> {
  return getConfigMergeArrays().flatMap((array) => {
    if (!isSegmentPrefix(segments, array)) {
      return [];
    }
    const items = getAtPath(value, array.slice(segments.length));
    const keyField = getConfigArrayMergeKey(array);
    if (!Array.isArray(items) || !keyField) {
      return [];
    }
    return items.flatMap((item) => {
      const key = isPlainRecord(item) ? item[keyField] : undefined;
      return typeof key === 'string' && key !== '' ? [{ segments: array, key }] : [];
    });
  });
}

/**
 * The tombstones a write at `segments` clears by path ({@link getClearedTombstones}: the path and
 * its ancestors below the section), leaving out any that would read as a keyed tombstone.
 * Segments name keys as written, so a segment `custom["Name"]` is a key of that spelling and never
 * entry `Name`, whose tombstones only a write of the entry itself clears.
 */
export function getPathClearedTombstones(segments: ConfigPathSegments): string[] {
  return getClearedTombstones(segments).filter((path) => readConfigEntryTombstone(path) == null);
}

/**
 * The stored tombstones a field write clears: the written path and its ancestors below the
 * section (so a whole-section tombstone survives a nested write), and for each entry the write
 * puts in an array merged by key, the tombstone that hides that whole entry
 * (`endpoints.custom["Name"]`). Tombstones inside an entry (`endpoints.custom["Name"].headers.X`)
 * stay, as a tombstone below any other written path does, and a keyed tombstone is never cleared
 * by a segment that only spells its path ({@link getPathClearedTombstones}).
 */
export function getWriteClearedTombstones(
  tombstones: readonly string[],
  segments: ConfigPathSegments,
  value: unknown,
): string[] {
  const cleared = new Set(getPathClearedTombstones(segments));
  const entries = getWrittenEntries(segments, value);
  return tombstones.filter(
    (tombstone) =>
      cleared.has(tombstone) ||
      entries.some((entry) => isConfigEntryTombstone(tombstone, entry.segments, entry.key)),
  );
}

/**
 * Sets each field in order, dropping the tombstones each write clears
 * ({@link getWriteClearedTombstones}). A path that continues below a scalar or into a named key
 * of an array throws a `ConfigPathError` instead of replacing what is stored.
 */
export function setConfigFields(
  state: ConfigOverrideState,
  writes: readonly ConfigFieldWrite[],
): ConfigOverrideState {
  let overrides = asRecord(state.overrides);
  let tombstones = state.tombstones;
  for (const { segments, value } of writes) {
    overrides = setAtPath(overrides, segments, value);
    const cleared = new Set(getWriteClearedTombstones(tombstones, segments, value));
    if (cleared.size > 0) {
      tombstones = tombstones.filter((path) => !cleared.has(path));
    }
  }
  return { overrides: overrides as Partial<TCustomConfig>, tombstones: [...tombstones] };
}

/** Writes `items` back at `segments`, removing the array (and emptied parents) once empty. */
function writeEntries(overrides: JsonRecord, segments: ConfigPathSegments, items: unknown[]) {
  if (items.length > 0) {
    return setAtPath(overrides, segments, items);
  }
  return pruneEmptyAncestors(unsetAtPath(overrides, segments), segments);
}

/** Whether an entry holds nothing but its key, so it overrides nothing it is merged onto. */
function holdsOnlyKey(entry: unknown, keyField: string): boolean {
  return isPlainRecord(entry) && Object.keys(entry).every((key) => key === keyField);
}

/**
 * Removes a keyed location from the principal's own entries: every entry with its key (by
 * identity), or the path inside each, with the objects that leaves empty. An entry left with
 * nothing but its key goes too, and the array once it is empty.
 */
function removeEntryLocation(overrides: JsonRecord, location: ConfigEntryLocation): JsonRecord {
  const items = getAtPath(overrides, location.segments);
  if (!Array.isArray(items) || !items.some((item) => isConfigEntryAt(location, item))) {
    return overrides;
  }
  const { rest } = location.entry;
  let changed = false;
  const next = items.flatMap((item) => {
    if (!isConfigEntryAt(location, item)) {
      return [item];
    }
    const trimmed =
      rest.length === 0 ? null : pruneEmptyAncestors(unsetAtPath(item as JsonRecord, rest), rest);
    if (trimmed === item) {
      return [item];
    }
    changed = true;
    return trimmed == null || holdsOnlyKey(trimmed, location.keyField) ? [] : [trimmed];
  });
  return changed ? writeEntries(overrides, location.segments, next) : overrides;
}

/** Removes each location, then the objects the removals left empty. */
function removeLocations(overrides: JsonRecord, locations: readonly ConfigLocation[]): JsonRecord {
  const paths = locations.filter((location) => !location.entry).map(({ segments }) => segments);
  const removed = paths.reduce((current, segments) => unsetAtPath(current, segments), overrides);
  const pruned = paths.reduce(
    (current, segments) => pruneEmptyAncestors(current, segments),
    removed,
  );
  return locations
    .filter((location) => location.entry)
    .reduce(
      (current, location) => removeEntryLocation(current, requireEntryLocation(location)),
      pruned,
    );
}

/**
 * Removes each path and prunes the objects the removals left empty, so a reset leaves no `{}`
 * shells behind (sibling values and array elements are never removed). Tombstones at or below
 * each path are dropped too, and tombstones elsewhere, including under a pruned ancestor, stay.
 *
 * A keyed location (`endpoints.custom["Name"]`, or a path inside the entry) resets the
 * principal's own entry of that key, or the path inside it, and drops the keyed tombstones of the
 * same entry at or below it; a path at or above the array drops every keyed tombstone under it.
 */
export function unsetConfigPaths(
  state: ConfigOverrideState,
  paths: readonly ConfigRemoval[],
): ConfigOverrideState {
  const locations = paths.map(toLocation);
  return {
    overrides: removeLocations(asRecord(state.overrides), locations) as Partial<TCustomConfig>,
    tombstones: state.tombstones.filter(
      (tombstone) => !locations.some((location) => isConfigTombstoneAtOrBelow(tombstone, location)),
    ),
  };
}

/** Whether a stored tombstone names exactly `location`, a keyed one by its key's identity. */
function isSameTombstone(tombstone: string, location: ConfigLocation, formatted: string): boolean {
  if (!location.entry) {
    return tombstone === formatted;
  }
  const stored = readConfigEntryTombstone(tombstone);
  return (
    stored != null &&
    isConfigTombstoneAtOrBelow(tombstone, location) &&
    stored.entry.rest.length === location.entry.rest.length
  );
}

/**
 * Suppresses each path: its override is removed (with the emptied ancestors, as in
 * {@link unsetConfigPaths}) and the path is recorded as a tombstone once. A segment that
 * contains a dot cannot be named by a tombstone and throws a `ConfigPathError`.
 *
 * A keyed location hides the inherited entry of that key, or the path inside it, and removes
 * the principal's own entry, or that path from it. Its tombstone is stored as a canonical keyed
 * path (`formatKeyedPath`), once per entry identity and path. A keyed location after an array
 * not merged by key throws a `ConfigPathError` (`keyed_path`).
 */
export function tombstoneConfigPaths(
  state: ConfigOverrideState,
  paths: readonly ConfigRemoval[],
): ConfigOverrideState {
  const locations = paths.map(toLocation);
  const tombstones = [...state.tombstones];
  for (const location of locations) {
    if (location.entry) {
      requireEntryLocation(location);
    }
    const formatted = formatConfigLocation(location);
    if (!tombstones.some((tombstone) => isSameTombstone(tombstone, location, formatted))) {
      tombstones.push(formatted);
    }
  }
  return {
    overrides: removeLocations(asRecord(state.overrides), locations) as Partial<TCustomConfig>,
    tombstones,
  };
}

/** A rename of one of the principal's own entries of the merged-by-key array at `segments`. */
export interface ConfigEntryRename {
  segments: ConfigPathSegments;
  from: string;
  to: string;
}

/** {@link renameConfigEntryTombstones} for each rename, in order. */
export function renameConfigEntriesTombstones(
  state: ConfigOverrideState,
  renames: readonly ConfigEntryRename[],
): ConfigOverrideState {
  return renames.reduce(
    (current, { segments, from, to }) => renameConfigEntryTombstones(current, segments, from, to),
    state,
  );
}

/**
 * Moves the keyed tombstones of entry `from` of the merged-by-key array at `segments` to entry
 * `to`, as a rename of the principal's own entry carries what it hides: each keeps its path
 * inside the entry. The tombstone that hides `to` whole goes, since the principal's own entry
 * now has that key, and a moved tombstone that `to` already has is kept once. A `to` no keyed
 * path can address (`isConfigEntryKey`), or `segments` that are not an array merged by key,
 * throw a `ConfigPathError` (`requireEntryLocation`), as the admin routes refuse such a rename:
 * a moved tombstone would name a path no read or removal can address.
 */
export function renameConfigEntryTombstones(
  state: ConfigOverrideState,
  segments: ConfigPathSegments,
  from: string,
  to: string,
): ConfigOverrideState {
  requireEntryLocation({ segments, entry: { key: to, rest: [] } });
  const fromIdentity = getConfigEntryIdentity(segments, from);
  const tombstones: string[] = [];
  let changed = false;
  for (const tombstone of state.tombstones) {
    const stored = readConfigEntryTombstone(tombstone);
    const moves =
      stored != null &&
      stored.identity === fromIdentity &&
      stored.segments.length === segments.length &&
      isSegmentPrefix(stored.segments, segments);
    const next = moves ? formatKeyedPath(segments, to, stored.entry.rest) : tombstone;
    const location = readConfigEntryTombstone(next);
    const kept =
      !isConfigEntryTombstone(next, segments, to) &&
      !tombstones.some((path) =>
        location ? isSameTombstone(path, location, next) : path === next,
      );
    if (kept) {
      tombstones.push(next);
    }
    if (!kept || next !== tombstone) {
      changed = true;
    }
  }
  return changed ? { overrides: state.overrides, tombstones } : state;
}
/** Replaces the overrides whole. Tombstones stay, so they keep shaping the inherited base. */
export function replaceConfigOverrides(
  state: ConfigOverrideState,
  overrides: Partial<TCustomConfig>,
): ConfigOverrideState {
  return { overrides, tombstones: [...state.tombstones] };
}

/**
 * Whether a document holds nothing: no tombstones, and overrides that are empty or hold only
 * empty objects (shells an older server's field reset left behind).
 */
export function isConfigOverrideStateEmpty(state: ConfigOverrideState): boolean {
  return state.tombstones.length === 0 && isEffectivelyEmpty(state.overrides);
}
