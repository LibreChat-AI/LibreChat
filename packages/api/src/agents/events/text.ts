/**
 * Text and links copied out of a provider's payload. Everything here was written by someone
 * outside the deployment, so it is bounded and cleaned before it is stored or shown.
 */

/** Most characters of one field that are looked at; the rest is never read. */
const SCAN = 16_384;
/** How far back from that bound the end of the last whole word is looked for. */
const TAIL = 1024;
const URL_MAX = 2048;
/** A fragment that names a place on the page, such as `#issuecomment-1`, and nothing else. */
const ANCHOR = /^#[A-Za-z0-9_-]{1,64}$/;

/**
 * Credential shapes removed from copied text. This is a net for the common accident, a token
 * or an authenticated URL pasted into a comment, and not a secret scanner. Each pattern is
 * matched in time linear in the text.
 */
const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/gi, '$1[redacted]@'],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi, '$1 [redacted]'],
];

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;

/** C0 and C1 controls other than tab and line feed, and the bidirectional overrides. */
function isControl(code: number): boolean {
  return (
    (code < SPACE && code !== TAB && code !== LF) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function isSpace(code: number): boolean {
  return code === SPACE || code === TAB || code === LF || code === CR;
}

/** `end`, one earlier when a cut there would leave half of a surrogate pair. */
function whole(value: string, end: number): number {
  const last = value.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

/**
 * The part of `value` that is read. A word the bound would cut in half is dropped whole, so
 * a credential can never survive as a fragment too short to recognise. Text with no white
 * space near the bound, as in a script written without spaces, loses its last 1,024
 * characters instead, which is longer than any fragment the patterns above would miss.
 */
function scanned(value: string): string {
  if (value.length <= SCAN) {
    return value;
  }
  const floor = SCAN - TAIL;
  let end = SCAN;
  while (end > floor && !isSpace(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return value.slice(0, whole(value, end));
}

/** Line endings become line feeds; controls that can hide or reorder text are removed. */
function clean(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === CR) {
      out += value.charCodeAt(index + 1) === LF ? '' : '\n';
    } else if (!isControl(code)) {
      out += value[index];
    }
  }
  return out;
}

function redact(value: string): string {
  return SECRETS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

/** At most `max` characters, ending in an ellipsis when cut and never on half of a pair. */
function clip(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, whole(value, max - 1)).trimEnd()}…`;
}

function bounded(value: unknown, max: number, flat: boolean): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const cleaned = redact(clean(scanned(value)));
  const text = clip((flat ? cleaned.replace(/\s+/g, ' ') : cleaned).trim(), max);
  return text.length > 0 ? text : undefined;
}

/**
 * A bounded, cleaned copy of a payload's text: at most `max` characters, with control
 * characters and recognised credentials removed. `undefined` for anything that is not text or
 * that has nothing left.
 */
export function excerpt(value: unknown, max: number): string | undefined {
  return bounded(value, max, false);
}

/**
 * As `excerpt`, on one line: every run of white space becomes a single space. For a title or
 * a name, which is shown in a heading where a line break could pass for a second heading.
 */
export function line(value: unknown, max: number): string | undefined {
  return bounded(value, max, true);
}

/**
 * A page address from a payload, reduced to origin, path and a plain anchor. `undefined` for
 * anything but an `http` or `https` address without credentials; a query string is dropped,
 * since none of the pages linked here needs one and it is where a token would ride.
 */
export function link(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > URL_MAX) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    return undefined;
  }
  return `${url.origin}${url.pathname}${ANCHOR.test(url.hash) ? url.hash : ''}`;
}
