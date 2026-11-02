/**
 * Segment addressing inside a config overrides document.
 *
 * A path is a list of keys, so a record key that contains a dot is still one segment. A dotted
 * `fieldPath` is an edge format: `parseFieldPath` splits it, which is lossless only when no key
 * on the path contains a dot. Tombstones are stored as dotted strings, so they can only name
 * paths whose segments contain no dots, or one entry of an array merged by key by its key
 * (`endpoints.custom["Name"].headers`, read with `parseConfigPath`), whatever the key holds.
 *
 * Every helper is pure: it never mutates its input and copies only the containers along the
 * path it changes.
 */

export type ConfigPathSegments = readonly string[];

type JsonRecord = { [key: string]: unknown };

/** Why a path cannot be applied to the document it was addressed against. */
export type ConfigPathErrorReason =
  /** The path has no segments, or a segment is empty. */
  | 'empty_path'
  /** The path continues below a value that is neither an object nor an array. */
  | 'scalar_parent'
  /** The path names a key inside an array; arrays are addressed by index only. */
  | 'array_key'
  /** The path names an array index past the end; a write may only replace or append one. */
  | 'array_index'
  /** The path ends on an array element, which a removal would leave as `null`. */
  | 'array_element'
  /** A tombstone names an array element or a path inside one; only whole arrays can be hidden. */
  | 'inside_array'
  /** A tombstone (or another dotted-path consumer) would have to split a segment with a dot. */
  | 'dotted_segment'
  /** A segment starts with `$` or names a reserved key (`__*`, `constructor`, `prototype`). */
  | 'unsafe_segment'
  /** The path is longer than {@link MAX_CONFIG_PATH_DEPTH} segments. */
  | 'too_deep'
  /**
   * An entry key step (`["name"]`) is malformed, follows something other than an array merged by
   * key, or appears where only a whole path is accepted (a write, or `segments`).
   */
  | 'keyed_path'
  /** A keyed path names the key field of its entry, which identifies the entry itself. */
  | 'merge_key';

/** The deepest path a client may address; config schemas nest far less than this. */
export const MAX_CONFIG_PATH_DEPTH = 32;

const UNSAFE_SEGMENT = /^(?:\$|__)|^(?:constructor|prototype)$/;

/**
 * A path that cannot be applied to the document as stored. The message never echoes the path,
 * which can carry submitted keys; callers that report it use `code` and `reason`.
 */
export class ConfigPathError extends Error {
  readonly code = 'CONFIG_PATH_INVALID';

  constructor(
    readonly segments: string[],
    readonly reason: ConfigPathErrorReason,
  ) {
    super(`Config path cannot be applied: ${reason}`);
    this.name = 'ConfigPathError';
  }
}

export function isConfigPathError(error: unknown): error is ConfigPathError {
  return (
    error instanceof ConfigPathError ||
    (error instanceof Error && (error as { code?: unknown }).code === 'CONFIG_PATH_INVALID')
  );
}

export function isPlainRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(target: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function isArrayIndex(segment: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(segment);
}

function assertSegments(segments: ConfigPathSegments): void {
  if (segments.length === 0 || segments.some((segment) => segment === '')) {
    throw new ConfigPathError([...segments], 'empty_path');
  }
}

/** Splits a dotted field path into segments. Lossless only for keys that contain no dot. */
export function parseFieldPath(fieldPath: string): string[] {
  return fieldPath.split('.');
}

/**
 * Validates a client-supplied segment path: 1 to {@link MAX_CONFIG_PATH_DEPTH} non-empty
 * strings, none starting with `$` or naming a reserved key. A segment may contain dots, which
 * is what segments are for: addressing a record key such as `us.anthropic.claude-sonnet-4-5`.
 */
export function parseConfigPathSegments(
  value: unknown,
): { ok: true; segments: string[] } | { ok: false; reason: ConfigPathErrorReason } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, reason: 'empty_path' };
  }
  if (value.length > MAX_CONFIG_PATH_DEPTH) {
    return { ok: false, reason: 'too_deep' };
  }
  for (const segment of value) {
    if (typeof segment !== 'string' || segment === '') {
      return { ok: false, reason: 'empty_path' };
    }
    if (UNSAFE_SEGMENT.test(segment)) {
      return { ok: false, reason: 'unsafe_segment' };
    }
  }
  return { ok: true, segments: [...(value as string[])] };
}

/** Whether a segment path can be written as a dotted field path without losing a key. */
export function isDotFreePath(segments: ConfigPathSegments): boolean {
  return segments.every((segment) => !segment.includes('.'));
}

/**
 * Joins segments into the dotted form tombstones are stored in. A segment holding `["` is
 * refused: stored tombstones read that as an entry key step ({@link parseConfigPath}).
 */
export function formatTombstonePath(segments: ConfigPathSegments): string {
  assertSegments(segments);
  if (!isDotFreePath(segments)) {
    throw new ConfigPathError([...segments], 'dotted_segment');
  }
  if (segments.some((segment) => segment.includes(KEY_STEP_OPEN))) {
    throw new ConfigPathError([...segments], 'keyed_path');
  }
  return segments.join('.');
}

/** An entry of a merged-by-key array, by its key, and a path inside it. */
export interface ConfigEntryStep {
  /** The entry's key (a custom endpoint's `name`), as written. */
  key: string;
  /** The path inside the entry; empty for the whole entry. */
  rest: ConfigPathSegments;
}

/**
 * Where a removal or tombstone lands: `segments`, or with `entry`, one entry of the array at
 * `segments` (merged by key) and a path inside it.
 */
export interface ConfigLocation {
  segments: ConfigPathSegments;
  entry?: ConfigEntryStep;
}

/** The longest entry key a keyed path can address. */
export const MAX_CONFIG_ENTRY_KEY_LENGTH = 256;

const KEY_STEP_OPEN = '["';

/**
 * Whether a dotted path holds an entry key step (`endpoints.custom["Name"]`). Such a path is
 * read with {@link parseConfigPath}, never split on its dots.
 */
export function isKeyedConfigPath(path: string): boolean {
  return path.includes(KEY_STEP_OPEN);
}

/** Dotted segments that are each non-empty and safe, and hold no entry key step. */
function readDottedSegments(text: string): string[] | null {
  const segments = text.split('.');
  const valid = segments.every(
    (segment) =>
      segment !== '' && !UNSAFE_SEGMENT.test(segment) && !segment.includes(KEY_STEP_OPEN),
  );
  return valid ? segments : null;
}

/** Index of the quote that closes the JSON string starting at `start`, or -1. */
function findStringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') {
      index++;
    } else if (text[index] === '"') {
      return index;
    }
  }
  return -1;
}

/**
 * Whether a keyed path can name an entry by `key`: 1 to {@link MAX_CONFIG_ENTRY_KEY_LENGTH}
 * characters, not starting with `$` or `__`, and not `constructor` or `prototype`.
 */
export function isConfigEntryKey(key: string): boolean {
  return key !== '' && key.length <= MAX_CONFIG_ENTRY_KEY_LENGTH && !UNSAFE_SEGMENT.test(key);
}

/** The entry key a JSON string literal holds, or `null` when it is not one a path may name. */
function readEntryKey(literal: string): string | null {
  let key: unknown;
  try {
    key = JSON.parse(literal);
  } catch {
    return null;
  }
  return typeof key === 'string' && isConfigEntryKey(key) ? key : null;
}

/**
 * Reads a stored tombstone or a client's `fieldPath`: a dotted path (split on its dots), or a
 * keyed path `<array>["<key>"](.<path>)?`, which names one entry of an array merged by key by
 * its key, a JSON string literal (so a name may hold dots, quotes, brackets or any other
 * character), and optionally a dotted path inside it. A keyed path has one key step, dot-free
 * segments that are non-empty and safe, a key of 1 to {@link MAX_CONFIG_ENTRY_KEY_LENGTH}
 * characters that does not start with `$` or `__` and is not `constructor` or `prototype`, and
 * at most {@link MAX_CONFIG_PATH_DEPTH} steps. `null` when a keyed path breaks any of these.
 * Whether the array is merged by key is the caller's to check.
 */
export function parseConfigPath(path: string): ConfigLocation | null {
  const open = path.indexOf(KEY_STEP_OPEN);
  if (open === -1) {
    return { segments: parseFieldPath(path) };
  }
  const segments = readDottedSegments(path.slice(0, open));
  const close = findStringEnd(path, open + 1);
  if (!segments || close === -1 || path[close + 1] !== ']') {
    return null;
  }
  const key = readEntryKey(path.slice(open + 1, close + 1));
  const after = path.slice(close + 2);
  if (key == null || (after !== '' && !after.startsWith('.'))) {
    return null;
  }
  const rest = after === '' ? [] : readDottedSegments(after.slice(1));
  if (!rest || segments.length + 1 + rest.length > MAX_CONFIG_PATH_DEPTH) {
    return null;
  }
  return { segments, entry: { key, rest } };
}

/** Why one step of a keyed location cannot be written in its stored form, or `null`. */
function getKeyedStepError(segment: string): ConfigPathErrorReason | null {
  if (segment === '') {
    return 'empty_path';
  }
  if (UNSAFE_SEGMENT.test(segment)) {
    return 'unsafe_segment';
  }
  if (segment.includes('.')) {
    return 'dotted_segment';
  }
  return segment.includes(KEY_STEP_OPEN) ? 'keyed_path' : null;
}

/**
 * Why a keyed location cannot be stored as the keyed path it names, or `null` when it can: its
 * stored form must read back as itself ({@link parseConfigPath}), so the array's segments and
 * the path inside the entry hold only non-empty, safe, dot-free steps with no key step, the key
 * is one {@link isConfigEntryKey} accepts, and the whole is at most
 * {@link MAX_CONFIG_PATH_DEPTH} steps deep.
 */
export function getKeyedLocationError(
  segments: ConfigPathSegments,
  entry: ConfigEntryStep,
): ConfigPathErrorReason | null {
  if (segments.length === 0) {
    return 'empty_path';
  }
  if (segments.length + 1 + entry.rest.length > MAX_CONFIG_PATH_DEPTH) {
    return 'too_deep';
  }
  for (const segment of [...segments, ...entry.rest]) {
    const reason = getKeyedStepError(segment);
    if (reason) {
      return reason;
    }
  }
  return isConfigEntryKey(entry.key) ? null : 'keyed_path';
}

/** The canonical keyed path of an entry and a path inside it (see {@link parseConfigPath}). */
export function formatKeyedPath(
  segments: ConfigPathSegments,
  key: string,
  rest: ConfigPathSegments = [],
): string {
  const entry = `${segments.join('.')}[${JSON.stringify(key)}]`;
  return rest.length === 0 ? entry : `${entry}.${rest.join('.')}`;
}

/** A location in its stored form: a dotted path, or a canonical keyed path. */
export function formatConfigLocation(location: ConfigLocation): string {
  return location.entry
    ? formatKeyedPath(location.segments, location.entry.key, location.entry.rest)
    : formatTombstonePath(location.segments);
}

/** Whether `prefix` addresses `segments` itself or one of its ancestors. */
export function isSegmentPrefix(prefix: ConfigPathSegments, segments: ConfigPathSegments): boolean {
  return (
    prefix.length <= segments.length &&
    prefix.every((segment, index) => segment === segments[index])
  );
}

/**
 * Whether a dotted tombstone names `segments` itself or a path below it, split on its dots. A
 * keyed tombstone is compared by its array with `isConfigTombstoneAtOrBelow` (`collections.ts`),
 * which knows the arrays merged by key.
 */
export function isTombstoneAtOrBelow(tombstone: string, segments: ConfigPathSegments): boolean {
  return isSegmentPrefix(segments, parseFieldPath(tombstone));
}

export function getAtPath(root: unknown, segments: ConfigPathSegments): unknown {
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current) && isArrayIndex(segment)) {
      current = current[Number(segment)];
    } else if (isPlainRecord(current) && hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function setInto(
  container: unknown,
  segments: ConfigPathSegments,
  depth: number,
  value: unknown,
): unknown {
  if (depth === segments.length) {
    return value;
  }
  const segment = segments[depth];
  if (Array.isArray(container)) {
    if (!isArrayIndex(segment)) {
      throw new ConfigPathError(segments.slice(0, depth + 1), 'array_key');
    }
    const index = Number(segment);
    if (index > container.length) {
      throw new ConfigPathError(segments.slice(0, depth + 1), 'array_index');
    }
    const next: unknown[] = [...container];
    next[index] = setInto(next[index], segments, depth + 1, value);
    return next;
  }
  if (container !== undefined && !isPlainRecord(container)) {
    throw new ConfigPathError(segments.slice(0, depth), 'scalar_parent');
  }
  const next: JsonRecord = { ...(container ?? {}) };
  const child = hasOwn(next, segment) ? next[segment] : undefined;
  /** Defined rather than assigned, so a `__proto__` key stays data instead of a prototype. */
  Object.defineProperty(next, segment, {
    value: setInto(child, segments, depth + 1, value),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return next;
}

/**
 * Sets `value` at `segments` the way a document store's field set does: missing objects on the
 * way are created and array elements are addressed by index. A path that continues below a
 * scalar, `null`, or a named key of an array is refused instead of silently replacing what is
 * there, and so is an index past the end of an array: an element can be replaced or appended,
 * never reached by padding the array with `null`, so the size of a write is bounded by the
 * document it lands on rather than by a number in the path.
 */
export function setAtPath(
  root: JsonRecord,
  segments: ConfigPathSegments,
  value: unknown,
): JsonRecord {
  assertSegments(segments);
  return setInto(root, segments, 0, value) as JsonRecord;
}

function removeFrom(container: unknown, segments: ConfigPathSegments, depth: number): unknown {
  const segment = segments[depth];
  const isLast = depth === segments.length - 1;
  if (Array.isArray(container)) {
    if (!isArrayIndex(segment) || Number(segment) >= container.length) {
      return container;
    }
    if (isLast) {
      throw new ConfigPathError([...segments], 'array_element');
    }
    const index = Number(segment);
    const child = removeFrom(container[index], segments, depth + 1);
    if (child === container[index]) {
      return container;
    }
    const next = [...container];
    next[index] = child;
    return next;
  }
  if (!isPlainRecord(container) || !hasOwn(container, segment)) {
    return container;
  }
  if (isLast) {
    const next = { ...container };
    delete next[segment];
    return next;
  }
  const child = removeFrom(container[segment], segments, depth + 1);
  if (child === container[segment]) {
    return container;
  }
  return { ...container, [segment]: child };
}

/**
 * Removes the value at `segments`. A missing path is a no-op (the input is returned as is). A
 * path ending on an existing array element is refused: removing it would either shift the
 * elements after it or leave a `null` hole, and arrays are written whole.
 */
export function unsetAtPath(root: JsonRecord, segments: ConfigPathSegments): JsonRecord {
  assertSegments(segments);
  return removeFrom(root, segments, 0) as JsonRecord;
}

function isEmptyRecord(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

/**
 * Removes the objects on the way to `segments` that hold nothing, deepest first, so a removed
 * leaf does not leave `{}` shells behind. It stops at the first ancestor that still holds a
 * value, at an array (an element is never removed), and at the document root, which stays.
 */
export function pruneEmptyAncestors(root: JsonRecord, segments: ConfigPathSegments): JsonRecord {
  let result = root;
  for (let depth = segments.length - 1; depth >= 1; depth--) {
    const ancestor = segments.slice(0, depth);
    if (!isEmptyRecord(getAtPath(result, ancestor))) {
      break;
    }
    if (!isPlainRecord(getAtPath(result, ancestor.slice(0, -1)))) {
      break;
    }
    result = removeFrom(result, ancestor, 0) as JsonRecord;
  }
  return result;
}

/** Whether `value` is an object that holds only objects that hold nothing (`{}`, `{ a: {} }`). */
export function isEffectivelyEmpty(value: unknown): boolean {
  return isPlainRecord(value) && Object.values(value).every(isEffectivelyEmpty);
}

/**
 * The stored tombstones a field write at `segments` clears: the written path and its ancestors
 * below the section, so a whole-section tombstone survives a nested write. Only the dot-free
 * prefix of the path can match a tombstone.
 */
export function getClearedTombstones(segments: ConfigPathSegments): string[] {
  const dotted = segments.findIndex((segment) => segment.includes('.'));
  const addressable = dotted === -1 ? segments : segments.slice(0, dotted);
  if (addressable.length === 0) {
    return [];
  }
  if (segments.length === 1) {
    return [addressable[0]];
  }
  const paths: string[] = [];
  for (let length = 2; length <= addressable.length; length++) {
    paths.push(addressable.slice(0, length).join('.'));
  }
  return paths;
}

/** {@link getClearedTombstones} for a dotted field path. */
export function getTombstonePathsToClear(fieldPath: string): string[] {
  return getClearedTombstones(parseFieldPath(fieldPath));
}
