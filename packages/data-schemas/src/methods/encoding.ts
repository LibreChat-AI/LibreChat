/**
 * Reversible object-key encoding for config overrides stored through Mongoose.
 *
 * MongoDB-compatible engines disagree about field names: MongoDB 4.4+ stores a dotted name
 * inside a document (5.0+ also a `$`-prefixed one), while DocumentDB, Cosmos DB, FerretDB and
 * older MongoDB may refuse them. The encoding keeps a refusing engine from ever storing one:
 * `%`, `.`, `$` and NUL are percent-escaped wherever they appear in a key, and nothing else
 * changes. Values are never touched. A PostgreSQL/JSONB engine stores plain JSON and needs
 * none of this, which is why it lives in the Mongoose binding only.
 *
 * Keys are written raw whenever the engine stores them and a raw read returns them unchanged,
 * so servers that predate the encoding (and read every key literally) keep reading what they
 * wrote during a rolling upgrade. A document is written encoded, with the marker, only when
 * the engine refused a raw key name, or when its keys look like escape sequences while none
 * holds a raw `.`, `$` or NUL (a raw read would decode them).
 *
 * Reads decode a marked document, including raw keys an older server added to it or a raw
 * replacement it wrote under a stale marker: the decoder only rewrites the four sequences this
 * module emits, so a raw key without one is unchanged. An unmarked document is decoded unless
 * some key holds a raw `.`, `$` or NUL, which no encoded document contains; that reads an
 * encoded document whose marker an older server dropped (its schema lacks the field), and
 * reads every raw document as stored. The one key such a reading can misread is a raw key
 * that literally spells `%25`, `%2E`, `%24` or `%00` in a document with no dotted key.
 */

/** Stored on a config document whose override keys are encoded. */
export const CONFIG_KEY_ENCODING_VERSION = 1;

const NUL = String.fromCharCode(0);

const ENCODED: Readonly<Record<string, string>> = {
  '%': '%25',
  '.': '%2E',
  $: '%24',
};

const DECODED: Readonly<Record<string, string>> = {
  '%25': '%',
  '%2E': '.',
  '%24': '$',
  '%00': NUL,
};

const ENCODE_PATTERN = /[%.$]/g;
const DECODE_PATTERN = /%(?:25|2E|24|00)/g;
/** A character only an unencoded key holds: the encoding escapes every one of them. */
const RAW_ONLY_PATTERN = /[.$\0]/;
const ESCAPE_PATTERN = /%(?:25|2E|24|00)/;

/** `%` is escaped first, so the `%` an escape introduces is never escaped again. */
export function encodeStoredKey(key: string): string {
  const escaped = key.replace(ENCODE_PATTERN, (character) => ENCODED[character]);
  return escaped.includes(NUL) ? escaped.split(NUL).join('%00') : escaped;
}

export function decodeStoredKey(key: string): string {
  return key.includes('%') ? key.replace(DECODE_PATTERN, (sequence) => DECODED[sequence]) : key;
}

/**
 * A JSON-style object: its prototype is `null` or a root `Object.prototype`, from any realm.
 * Comparing with this realm's `Object.prototype` would skip an object built in another one
 * (`structuredClone` under Jest returns the host realm's objects), and a skipped object keeps
 * its dotted keys raw at rest.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/**
 * Rewrites every key of every plain object below `value`, keeping JSON semantics: an
 * `undefined` property is dropped and an `undefined` array element becomes `null`. Containers
 * nothing changed in are returned as they are.
 */
function mapKeys(value: unknown, mapKey: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = item === undefined ? null : mapKeys(item, mapKey);
      changed ||= mapped !== item;
      return mapped;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  let changed = false;
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      changed = true;
      continue;
    }
    const nextKey = mapKey(key);
    const nextChild = mapKeys(child, mapKey);
    changed ||= nextKey !== key || nextChild !== child;
    entries.push([nextKey, nextChild]);
  }
  return changed ? Object.fromEntries(entries) : value;
}

/** Encodes every key below `value` for storage. */
export function encodeStoredKeys<T>(value: T): T {
  return mapKeys(value, encodeStoredKey) as T;
}

/** Decodes every key below `value` that {@link encodeStoredKeys} wrote. */
export function decodeStoredKeys<T>(value: T): T {
  return mapKeys(value, decodeStoredKey) as T;
}

/** Decodes nothing; applies the same JSON rules as the encoding to a raw write. */
function normalizeStoredKeys<T>(value: T): T {
  return mapKeys(value, (key) => key) as T;
}

/** What the keys below a value hold: a raw-only character, and an escape sequence. */
interface StoredKeyScan {
  raw: boolean;
  escaped: boolean;
}

function scanKeys(value: unknown, scan: StoredKeyScan): StoredKeyScan {
  if (scan.raw && scan.escaped) {
    return scan;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      scanKeys(item, scan);
    }
    return scan;
  }
  if (!isPlainObject(value)) {
    return scan;
  }
  for (const [key, child] of Object.entries(value)) {
    scan.raw ||= RAW_ONLY_PATTERN.test(key);
    scan.escaped ||= ESCAPE_PATTERN.test(key);
    scanKeys(child, scan);
  }
  return scan;
}

/** The overrides as a read returns them: see the module comment for when they are decoded. */
export function readStoredKeys<T>(value: T, marked: boolean): T {
  return marked || !scanKeys(value, { raw: false, escaped: false }).raw
    ? decodeStoredKeys(value)
    : value;
}

/** How overrides go to the engine: `raw` keys as written, or `encoded` with the marker. */
export type StoredKeyForm = 'raw' | 'encoded';

/**
 * The forms to try, in order, for writing `value`: raw when a raw read returns it unchanged,
 * falling back to encoded when its keys hold a name an engine may refuse (`.`, `$`, NUL) and
 * the engine does refuse it. `refusesRawKeys` skips the raw attempt once the engine has.
 */
export function getStoredKeyForms(value: unknown, refusesRawKeys: boolean): StoredKeyForm[] {
  const { raw, escaped } = scanKeys(value, { raw: false, escaped: false });
  if (!raw) {
    return [escaped ? 'encoded' : 'raw'];
  }
  return refusesRawKeys ? ['encoded'] : ['raw', 'encoded'];
}

/** The keys below `value` in `form`. */
export function toStoredKeys<T>(value: T, form: StoredKeyForm): T {
  return form === 'encoded' ? encodeStoredKeys(value) : normalizeStoredKeys(value);
}
