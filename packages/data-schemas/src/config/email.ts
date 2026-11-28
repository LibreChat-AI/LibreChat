/**
 * Email masking for log redaction, as one linear scan instead of regular expressions.
 *
 * What is masked. For each at sign (`@`, or `%40` percent-encoded up to eight times as `%2540`,
 * `%252540`, ...) the scanner reads the local part to its left and the domain to its right and
 * replaces that whole span with `[REDACTED_EMAIL]`, keeping the text around it:
 * - local part: Unicode letters, marks, digits and symbols, the RFC 5322 atext punctuation and
 *   dots, a quoted local part (raw, or JSON-serialized at any depth), RFC 5322 comments and
 *   JSON `\uXXXX` escapes; in a percent-encoded address `& = ? / #` are URL syntax and end it;
 * - domain: labels of letters, marks, digits, `-` and `_` joined by dots (`.`, `。`, `．`, `｡`,
 *   `%2E`), with `%XX` and `\uXXXX` units and a comma or semicolon between labels, or a
 *   bracketed address literal; a domain outside that grammar falls back to the delimiter-bounded
 *   token the earlier regular expressions matched, so nothing they masked is shown now;
 * - zero-width and other format characters (Unicode Cf) count as part of the address, while
 *   `mailto:`, `<...>`, quotes, brackets and URL schemes around it stay outside the mask.
 * Each part is read for at most MAX_PART code units and a longer part is masked from that bound
 * outward, so reading MAX_SPAN units around a cut finds every address the cut splits.
 *
 * What is not masked: obfuscated text (`jane at example dot com`), names, phone numbers, other
 * encodings of the at sign (`&#64;`, `\u0040`, `＠`), an empty local part (`@handle`), a domain
 * without a dot (`user@localhost`), and a package scope in a path (`node_modules/@scope/pkg`).
 */

export const REDACTED_EMAIL = '[REDACTED_EMAIL]';
/** Most code units read for one local part or one domain. */
export const MAX_PART = 2048;
/** Most `%25` prefixes an encoded at sign or dot may carry (`%2540` has one). */
const MAX_ENCODING = 8;
/** Widest span a single address covers: both parts and the longest encoded at sign. */
export const MAX_SPAN: number = 2 * MAX_PART + 3 + 2 * MAX_ENCODING;

export type Span = { start: number; end: number };

/** Where a local part starts, how many words it holds, and whether an escape stopped it. */
type Part = { start: number; words: number; stuck: boolean };
/** End of the last encoded fallback domain without a dot; a run starting inside it has none. */
type Scan = { skip: number };
type Word = { start: number; open: boolean };

const KNOWN = 1;
/** A local-part character. */
const LOCAL = 2;
/** A domain label character. */
const LABEL = 4;
/** A zero-width or other format character, read as part of the address. */
const FORMAT = 8;
const SPACE = 16;
/** URL syntax that ends a percent-encoded local part. */
const URL = 32;
/** Delimiters that ended a domain in the earlier patterns, for `@` and for `%40`. */
const ENDS_PLAIN = 64;
const ENDS_ENCODED = 128;

const AT = 0x40;
const PERCENT = 0x25;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const DOT = 0x2e;
const COMMA = 0x2c;
const COLON = 0x3a;
const SEMICOLON = 0x3b;
const OPEN = 0x28;
const CLOSE = 0x29;
const BRACKET = 0x5b;
const BRACKET_END = 0x5d;
const LF = 0x0a;
const CR = 0x0d;

const ascii = new Uint8Array(128);
for (let code = 0; code < 128; code++) {
  const char = String.fromCharCode(code);
  let flags = KNOWN;
  if (/[A-Za-z0-9_-]/.test(char)) {
    flags |= LOCAL | LABEL;
  } else if ("!#$%&'*+/=?^`{|}~.".includes(char)) {
    flags |= LOCAL;
  }
  if ('&=?/#'.includes(char)) {
    flags |= URL;
  }
  if (/\s/.test(char)) {
    flags |= SPACE | ENDS_PLAIN | ENDS_ENCODED;
  }
  if ('<>[],;"'.includes(char)) {
    flags |= ENDS_PLAIN;
  }
  if ('<>"&=?/#'.includes(char)) {
    flags |= ENDS_ENCODED;
  }
  ascii[code] = flags;
}

const unicode = new Uint8Array(0x10000);
const formatPattern = /\p{Cf}/u;
const labelPattern = /[\p{L}\p{M}\p{N}]/u;
/** Separators, controls, brackets, quotes and sentence punctuation end a local part. */
const breakPattern = /[\p{Z}\p{Cc}\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Po}]/u;
const spacePattern = /\s/u;
/** IDNA context characters allowed inside a label (middle dots, keraia, geresh, gershayim). */
const inLabel = new Set([0xb7, 0x375, 0x5f3, 0x5f4, 0x30fb]);
/** Word-internal punctuation kept in a local part, including the typographic apostrophe. */
const inWord = new Set([0xb7, 0x5f3, 0x5f4, 0x2019, 0x30fb]);
/** Ideographic, full-width and half-width full stops, which IDNA reads as dots. */
const wideDots = new Set([0x3002, 0xff0e, 0xff61]);

function compute(point: number): number {
  const char = String.fromCodePoint(point);
  if (formatPattern.test(char)) {
    return KNOWN | FORMAT;
  }
  let flags = KNOWN;
  if (labelPattern.test(char) || inLabel.has(point)) {
    flags |= LABEL;
  }
  if (!breakPattern.test(char) || inWord.has(point)) {
    flags |= LOCAL;
  }
  if (spacePattern.test(char)) {
    flags |= SPACE;
  }
  return flags;
}

function classify(point: number): number {
  if (point < 0x80) {
    return ascii[point];
  }
  if (point > 0xffff) {
    return compute(point);
  }
  return unicode[point] || (unicode[point] = compute(point));
}

/** The code point that ends at `end`, joining a surrogate pair. */
function before(text: string, end: number): number {
  const low = text.charCodeAt(end - 1);
  if (low >= 0xdc00 && low <= 0xdfff && end > 1) {
    const high = text.charCodeAt(end - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
    }
  }
  return low;
}

function width(point: number): number {
  return point > 0xffff ? 2 : 1;
}

function isHex(code: number): boolean {
  const lower = code | 0x20;
  return (code >= 0x30 && code <= 0x39) || (lower >= 0x61 && lower <= 0x66);
}

/** Length of `%` plus up to MAX_ENCODING `25` prefixes plus `last`, or 0. */
function percent(text: string, index: number, last: string): number {
  if (text.charCodeAt(index) !== PERCENT) {
    return 0;
  }
  let cursor = index + 1;
  for (let level = 0; level <= MAX_ENCODING; level++) {
    const pair = text.substring(cursor, cursor + 2).toLowerCase();
    if (pair === last) {
      return cursor + 2 - index;
    }
    if (pair !== '25') {
      return 0;
    }
    cursor += 2;
  }
  return 0;
}

function encodedAt(text: string, index: number): number {
  return percent(text, index, '40');
}

/** Width of an at sign at `index`: 1 for `@`, the encoded length for `%40`, else 0. */
function atSign(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === AT) {
    return 1;
  }
  return code === PERCENT ? encodedAt(text, index) : 0;
}

/** UTF-8 bytes of the IDNA full stops, as percent-encoding writes them. */
const encodedDots = ['e38082', 'efbc8e', 'efbda1'];

/** Width of an IDNA full stop percent-encoded at one `%25` level throughout, else 0. */
function encodedWideDot(text: string, index: number): number {
  let prefix = 1;
  while (
    prefix < 1 + 2 * MAX_ENCODING &&
    text.substring(index + prefix, index + prefix + 2) === '25'
  ) {
    prefix += 2;
  }
  if ((text.charCodeAt(index + prefix) | 0x20) !== 0x65) {
    return 0;
  }
  const step = prefix + 2;
  let bytes = '';
  for (let byte = 0; byte < 3; byte++) {
    const at = index + byte * step;
    if (
      text.charCodeAt(at) !== PERCENT ||
      text.substring(at + 1, at + prefix) !== '25'.repeat((prefix - 1) / 2)
    ) {
      return 0;
    }
    bytes += text.substring(at + prefix, at + step).toLowerCase();
  }
  return encodedDots.includes(bytes) ? 3 * step : 0;
}

/** Width of a dot at `index`: `.`, an IDNA full stop, or an encoded one (`%2E`, `%E3%80%82`). */
function dot(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === DOT || wideDots.has(code)) {
    return 1;
  }
  if (code !== PERCENT) {
    return 0;
  }
  return percent(text, index, '2e') || encodedWideDot(text, index);
}

/** Width of a JSON `\uXXXX` escape at `index`, else 0. */
function escape(text: string, index: number): number {
  if (text.charCodeAt(index) !== BACKSLASH || text.charCodeAt(index + 1) !== 0x75) {
    return 0;
  }
  for (let offset = 2; offset < 6; offset++) {
    if (!isHex(text.charCodeAt(index + offset))) {
      return 0;
    }
  }
  return 6;
}

/** Width of one label unit at `index`: a label character, `%XX` or `\uXXXX`, else 0. */
function label(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === PERCENT) {
    if (encodedAt(text, index) > 0 || dot(text, index) > 0) {
      return 0;
    }
    return isHex(text.charCodeAt(index + 1)) && isHex(text.charCodeAt(index + 2)) ? 3 : 0;
  }
  if (code === BACKSLASH) {
    return escape(text, index);
  }
  const point = text.codePointAt(index) ?? 0;
  return classify(point) & LABEL ? width(point) : 0;
}

/** Width of a format character at `index`, else 0. */
function format(text: string, index: number): number {
  const point = text.codePointAt(index) ?? 0;
  return classify(point) & FORMAT ? width(point) : 0;
}

/** Trailing ones of a backslash count: how many serializations escaped the quote after it. */
function depth(slashes: number): number {
  let level = 0;
  for (let rest = slashes; rest & 1; rest >>= 1) {
    level++;
  }
  return level;
}

/**
 * The quoted word whose closing quote is at `close`: its opening quote is the nearest one at the
 * same escape depth. A quote escaped deeper is content; a shallower one opens the string the word
 * sits in, so a serialized word with no opening of its own is masked from just after it, and a
 * raw one from the farthest escaped quote it passed.
 */
function quoted(text: string, close: number, bound: number): Word | undefined {
  let cursor = close - 1;
  let slashes = 0;
  while (cursor >= bound && text.charCodeAt(cursor) === BACKSLASH) {
    slashes++;
    cursor--;
  }
  const level = depth(slashes);
  /** The farthest quote escaped deeper than this one, where an unmatched word is masked from. */
  let deeper = -1;
  while (cursor >= bound) {
    const code = text.charCodeAt(cursor);
    if (code === CR || code === LF) {
      if (level > 0) {
        return { start: cursor + 1, open: false };
      }
      return deeper < 0 ? undefined : { start: deeper, open: false };
    }
    if (code !== QUOTE) {
      cursor--;
      continue;
    }
    let previous = cursor - 1;
    let run = 0;
    while (previous >= bound && text.charCodeAt(previous) === BACKSLASH) {
      run++;
      previous--;
    }
    if (previous < bound && bound > 0) {
      return { start: bound, open: false };
    }
    const found = depth(run);
    if (found === level) {
      return { start: previous + 1, open: true };
    }
    if (found < level) {
      return { start: cursor + 1, open: false };
    }
    deeper = previous + 1;
    cursor = previous;
  }
  if (bound > 0) {
    return { start: bound, open: false };
  }
  if (level > 0) {
    return { start: 0, open: false };
  }
  return deeper < 0 ? undefined : { start: deeper, open: false };
}

/** Index of the quote closing a quoted string inside a comment, or `open` when there is none. */
function closingQuote(text: string, open: number): number {
  const limit = Math.min(text.length, open + 1 + MAX_PART);
  for (let cursor = open + 1; cursor < limit; cursor++) {
    const code = text.charCodeAt(cursor);
    if (code === QUOTE) {
      return cursor;
    }
    if (code === CR || code === LF) {
      return open;
    }
    if (code === BACKSLASH) {
      cursor++;
    }
  }
  return open;
}

/**
 * Index of the quote that closes a serialized quoted string opened at `open`: the next quote at the
 * same escape depth (`level`), or `open` when the line or the bound ends first.
 */
function closingRun(text: string, open: number, level: number): number {
  const limit = Math.min(text.length, open + 1 + MAX_PART);
  let run = 0;
  for (let cursor = open + 1; cursor < limit; cursor++) {
    const code = text.charCodeAt(cursor);
    if (code === QUOTE && depth(run) === level) {
      return cursor;
    }
    if (code === CR || code === LF) {
      return open;
    }
    run = code === BACKSLASH ? run + 1 : 0;
  }
  return open;
}

/**
 * The opening parenthesis of every closing one, in one forward pass over RFC 5322 comments: they
 * nest and may hold whitespace, at signs and quoted strings, and a line break ends every open one.
 * Raw text reads a backslash as escaping the one character after it; `serialized` reads a run of
 * backslashes and the character after it as content, as JSON escaping doubles them, except that an
 * odd run before a quote opens a quoted string one level down.
 */
function comments(text: string, serialized: boolean): Map<number, number> {
  const pairs = new Map<number, number>();
  const opens: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === OPEN) {
      opens.push(index);
    } else if (code === CLOSE) {
      const open = opens.pop();
      if (open !== undefined) {
        pairs.set(index, open);
      }
    } else if (code === CR || code === LF) {
      opens.length = 0;
    } else if (opens.length > 0 && code === QUOTE) {
      index = closingQuote(text, index);
    } else if (opens.length > 0 && code === BACKSLASH) {
      let run = 1;
      while (serialized && text.charCodeAt(index + run) === BACKSLASH) {
        run++;
      }
      const next = index + run;
      if (serialized && run % 2 === 1 && text.charCodeAt(next) === QUOTE) {
        index = closingRun(text, next, depth(run));
      } else {
        index = serialized ? next : index + 1;
      }
    }
  }
  return pairs;
}

/** Whether the solidus at `index` closes a `scheme://`, after which a URL authority starts. */
function authority(text: string, index: number): boolean {
  const limit = Math.max(0, index - MAX_PART);
  let cursor = index;
  while (cursor > limit && text.charCodeAt(cursor - 1) === SLASH) {
    cursor--;
  }
  return cursor < index && text.charCodeAt(cursor - 1) === COLON;
}

/**
 * Where the local part that ends at `at` starts. Plain characters are read back to `floor` (the
 * previous at sign or mask) and at most MAX_PART units; a quoted word or a comment (`opening`
 * gives its opening parenthesis) may reach further, since either can hold an at sign. A comment
 * is no word, so a part of comments alone counts none; `stuck` is set when a closing parenthesis
 * or a backslash escape the grammar cannot read ends the part, as in a serialized comment.
 */
function local(
  text: string,
  at: number,
  floor: number,
  encoded: boolean,
  opening: (close: number) => number,
): Part {
  const bound = Math.max(0, at - MAX_PART);
  /** Once a quoted word or comment reads past the floor, the part may run on to the bound. */
  let limit = Math.max(floor, bound);
  let start = at;
  let words = 0;
  /** A quoted word may close here: at the at sign or before a dot. */
  let wordEnd = true;
  /** After a quoted word only a dot continues the part (RFC 5322 obs-local-part). */
  let needDot = false;
  while (start > limit) {
    const point = before(text, start);
    const size = width(point);
    if (start - size < limit) {
      break;
    }
    const flags = classify(point);
    if (flags & FORMAT) {
      start -= size;
      continue;
    }
    if (needDot && point !== DOT) {
      break;
    }
    if (point === QUOTE && wordEnd) {
      const word = quoted(text, start - 1, bound);
      if (word === undefined) {
        break;
      }
      start = word.start;
      limit = start < limit ? bound : limit;
      words++;
      if (!word.open) {
        break;
      }
      wordEnd = false;
      needDot = true;
      continue;
    }
    if (point === CLOSE) {
      const open = opening(start - 1);
      if (open < bound) {
        return { start, words, stuck: true };
      }
      start = open;
      limit = start < limit ? bound : limit;
      wordEnd = true;
      needDot = false;
      continue;
    }
    if (point === BACKSLASH) {
      /** `\uXXXX` and `\/` were read as atext; their backslash belongs to the part. */
      if (escape(text, start - 1) === 0 && text.charCodeAt(start) !== SLASH) {
        return { start, words, stuck: true };
      }
      start -= 1;
      words++;
      wordEnd = false;
      continue;
    }
    if (!(flags & LOCAL) || (encoded && flags & URL)) {
      break;
    }
    /** A run of solidi is checked once, at its last one: the rest were part of that check. */
    if (
      point === SLASH &&
      !encoded &&
      text.charCodeAt(start) !== SLASH &&
      authority(text, start - 1)
    ) {
      break;
    }
    start -= size;
    words++;
    wordEnd = point === DOT;
    needDot = false;
  }
  return { start, words, stuck: false };
}

/**
 * An at sign that opens a directory under `node_modules` names a package scope in a file path or
 * stack frame (`node_modules/@scope.name/pkg`), not an address, so frame locations stay readable.
 */
function scope(text: string, at: number): boolean {
  let cursor = at;
  while (
    cursor > 0 &&
    (text.charCodeAt(cursor - 1) === SLASH || text.charCodeAt(cursor - 1) === BACKSLASH)
  ) {
    cursor--;
  }
  return cursor < at && text.endsWith('node_modules', cursor);
}

/**
 * A comma or semicolon at `index - 1` joins labels when a label or dot follows it, unless the
 * domain before it is already complete (`listed`) and the run after it ends at an at sign, which
 * makes that run the next address's local part in a list.
 */
function joins(text: string, index: number, limit: number, listed: boolean): boolean {
  let cursor = index;
  let read = false;
  while (cursor < limit) {
    const size = label(text, cursor) || dot(text, cursor);
    if (size > 0) {
      read = true;
      cursor += size;
      continue;
    }
    const skip = format(text, cursor);
    if (skip === 0) {
      break;
    }
    cursor += skip;
  }
  return read && !(listed && atSign(text, cursor) > 0);
}

/** End of a dotted run of labels from `from`, or 0 when no dot sits between two labels. */
function labels(text: string, from: number, limit: number): number {
  let cursor = from;
  let end = 0;
  let seen = false;
  let dotted = false;
  let valid = false;
  while (cursor < limit) {
    const unit = label(text, cursor);
    if (unit > 0) {
      cursor += unit;
      valid ||= dotted;
      seen = true;
      end = cursor;
      continue;
    }
    const stop = dot(text, cursor);
    if (stop > 0) {
      dotted ||= seen;
      cursor += stop;
      continue;
    }
    const skip = format(text, cursor);
    if (skip > 0) {
      cursor += skip;
      continue;
    }
    const code = text.charCodeAt(cursor);
    if ((code === COMMA || code === SEMICOLON) && seen && joins(text, cursor + 1, limit, valid)) {
      cursor++;
      continue;
    }
    break;
  }
  return valid ? end : 0;
}

/** Characters that ended a part in the earlier patterns, which `loose` and `token` keep. */
function ends(code: number, encoded: boolean): boolean {
  if (code === AT) {
    return !encoded;
  }
  if (code >= 0x80) {
    return (classify(code) & SPACE) !== 0;
  }
  return (ascii[code] & (encoded ? ENDS_ENCODED : ENDS_PLAIN)) !== 0;
}

/**
 * The domain the earlier patterns matched: a delimiter-bounded token with a dot between two of
 * its characters, trimmed of trailing ASCII punctuation, which holds no part of the address. As
 * there, it runs on across later at signs; an encoded run without a dot is remembered, so the
 * encoded at signs inside it are not read again.
 */
function loose(text: string, from: number, limit: number, encoded: boolean, scan: Scan): number {
  if (encoded && from < scan.skip) {
    return 0;
  }
  let cursor = from;
  let end = 0;
  let pending = false;
  let valid = false;
  while (cursor < limit) {
    const code = text.charCodeAt(cursor);
    if (ends(code, encoded)) {
      break;
    }
    valid ||= pending;
    let stop = code === DOT ? 1 : 0;
    if (stop === 0 && encoded) {
      stop = percent(text, cursor, '2e');
    }
    pending ||= stop > 0 && cursor > from;
    cursor += stop || 1;
    if (code >= 0x80 || ascii[code] & LABEL) {
      end = cursor;
    }
  }
  if (encoded && !valid) {
    scan.skip = cursor;
  }
  return valid ? end : 0;
}

/** Index after the closing bracket of an address literal at `from`, else 0. */
function literal(text: string, from: number, limit: number): number {
  for (let cursor = from + 1; cursor < limit; cursor++) {
    const code = text.charCodeAt(cursor);
    if (code === BRACKET_END) {
      return cursor > from + 1 ? cursor + 1 : 0;
    }
    if (code === AT || classify(code) & SPACE) {
      return 0;
    }
  }
  return 0;
}

/** Index after a percent-encoded address literal (`%5B...%5D`, `%255B...`) at `from`, else 0. */
function encodedLiteral(text: string, from: number, limit: number): number {
  const open = percent(text, from, '5b');
  if (open === 0) {
    return 0;
  }
  for (let cursor = from + open; cursor < limit; cursor++) {
    const code = text.charCodeAt(cursor);
    const close = code === PERCENT ? percent(text, cursor, '5d') : 0;
    if (close > 0) {
      return cursor > from + open ? cursor + close : 0;
    }
    if (code === AT || classify(code) & SPACE || encodedAt(text, cursor) > 0) {
      return 0;
    }
  }
  return 0;
}

/** Whether `text` between `from` and `end` holds a dot followed by a label: more domain. */
function dotted(text: string, from: number, end: number): boolean {
  for (let cursor = from; cursor < end; cursor++) {
    const size = dot(text, cursor);
    if (size > 0 && cursor + size < end && label(text, cursor + size) > 0) {
      return true;
    }
  }
  return false;
}

/**
 * End of the domain after an at sign. The labels end it in place, unless the delimiter-bounded
 * token of the earlier patterns runs on past them into another dotted label (`exa.mple'x.com`),
 * which is more of a malformed domain: then the token ends it, as it did before.
 */
function domain(text: string, from: number, encoded: boolean, scan: Scan): number {
  const limit = Math.min(text.length, from + MAX_PART);
  if (text.charCodeAt(from) === BRACKET) {
    return literal(text, from, limit);
  }
  const bracketed = encodedLiteral(text, from, limit);
  if (bracketed > 0) {
    return bracketed;
  }
  const strict = labels(text, from, limit);
  const fallback = loose(text, from, limit, encoded, scan);
  if (strict === 0) {
    return fallback;
  }
  return fallback > strict && dotted(text, strict, fallback) ? fallback : strict;
}

/** Start of the token the earlier patterns read as a local part: back to one of their delimiters. */
function token(text: string, at: number, limit: number, encoded: boolean): number {
  let start = at;
  while (start > limit && !ends(text.charCodeAt(start - 1), encoded)) {
    start--;
  }
  return start;
}

/** Appends a span, folding in the spans it overlaps. */
function add(spans: Span[], start: number, end: number): void {
  let from = start;
  while (spans.length > 0 && spans[spans.length - 1].end > from) {
    from = Math.min(from, (spans.pop() as Span).start);
  }
  spans.push({ start: from, end });
}

/** Whether `text` holds an at sign the scanner reads: `@` or a percent-encoded `%40`. */
export function hasAtSign(text: string): boolean {
  if (text.includes('@')) {
    return true;
  }
  for (let index = text.indexOf('%'); index >= 0; index = text.indexOf('%', index + 1)) {
    if (encodedAt(text, index) > 0) {
      return true;
    }
  }
  return false;
}

/**
 * The address spans in `text`, in order and without overlap. A part read up to the at sign before
 * it continues that at sign's part, and one read into the mask before it joins that mask, so text
 * glued to an address never escapes it.
 */
export function findEmails(text: string): Span[] {
  const spans: Span[] = [];
  if (!hasAtSign(text)) {
    return spans;
  }
  const scan: Scan = { skip: 0 };
  /** A comment's escapes may be raw or serialized: of the two pairings, the wider one is masked. */
  let pairs: Array<Map<number, number>> | undefined;
  const opening = (close: number): number => {
    pairs ??= [comments(text, false), comments(text, true)];
    const raw = pairs[0].get(close) ?? -1;
    const serialized = pairs[1].get(close) ?? -1;
    return raw < 0 || serialized < 0 ? Math.max(raw, serialized) : Math.min(raw, serialized);
  };
  /** End of the previous at sign, the start of its local part, and whether it was masked. */
  let mark = 0;
  let origin = 0;
  let masked = true;
  let index = 0;
  while (index < text.length) {
    const size = atSign(text, index);
    if (size === 0) {
      index++;
      continue;
    }
    const encoded = size > 1;
    const end = index + size;
    const last = spans.length > 0 ? spans[spans.length - 1] : undefined;
    const floor = masked ? (last?.end ?? 0) : mark;
    const part = local(text, index, floor, encoded, opening);
    let start = part.start;
    let read = part.words > 0;
    /** No word the grammar reads (a stray parenthesis, a comment alone, a colon), or an escape it
     * cannot read: the token before the at sign stays masked, as the earlier patterns masked it. */
    if (!read || part.stuck) {
      const fallback = token(text, index, Math.max(floor, index - MAX_PART), encoded);
      if (fallback < index) {
        start = Math.min(start, fallback);
        read = true;
      }
    }
    if (start === floor && floor > 0) {
      if (!masked) {
        start = Math.max(origin, index - MAX_PART);
        read = true;
      } else if (last !== undefined && classify(before(text, floor)) & LOCAL) {
        start = last.start;
        read = true;
      }
    }
    const stop = read && !(size === 1 && scope(text, index)) ? domain(text, end, encoded, scan) : 0;
    mark = end;
    if (stop === 0) {
      /** Text glued to the next at sign inherits this start, so reach back as far as the token. */
      origin = Math.min(start, token(text, index, Math.max(floor, index - MAX_PART), encoded));
      masked = false;
      index = end;
      continue;
    }
    add(spans, start, stop);
    masked = true;
    index = stop;
  }
  return spans;
}

/** Replaces each span with the placeholder, keeping text up to `end`. */
export function maskSpans(text: string, spans: Span[], end: number = text.length): string {
  let output = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start >= end) {
      break;
    }
    output += text.substring(cursor, span.start) + REDACTED_EMAIL;
    cursor = span.end;
  }
  return cursor < end ? output + text.substring(cursor, end) : output;
}

/** Masks every email address in `text` (see the coverage contract above). */
export function maskEmails(text: string): string {
  const spans = findEmails(text);
  return spans.length === 0 ? text : maskSpans(text, spans);
}
