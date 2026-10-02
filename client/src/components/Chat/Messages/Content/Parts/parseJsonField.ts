type ToolCallArgs = string | Record<string, unknown> | undefined;

export function areToolCallArgsComplete(args: ToolCallArgs): boolean {
  if (typeof args === 'object' && args !== null) {
    return true;
  }
  if (typeof args !== 'string' || !args.trimEnd().endsWith('}')) {
    return false;
  }
  try {
    const parsed = JSON.parse(args);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** Matches `"field":"value"`, tolerating a missing closing quote and a dangling escape at the end of partially streamed args. */
function fieldRegex(field: string, flags?: string): RegExp {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${escaped}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(?:"|\\\\?$)`, flags);
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/',
};

/**
 * Decodes the full JSON string escape set so a partially streamed value
 * renders exactly as its settled `JSON.parse` form will — without this,
 * `café` displays literally mid-stream and then snaps to `café` once
 * the object becomes valid JSON. Stream-boundary incompletions (a dangling
 * `\`, a partial `\uXX`, or the high half of a split surrogate pair) are
 * dropped rather than shown, since the next delta completes them; unknown
 * escapes elsewhere are preserved literally. Callers that KNOW the value is
 * settled (its closing quote was present) pass `streaming: false` so a value
 * genuinely ending in a lone high surrogate keeps its final code unit,
 * matching `JSON.parse`.
 */
export function unescapeJsonString(value: string, streaming = true): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) {
      break;
    }
    i++;
    if (next !== 'u') {
      out += SIMPLE_ESCAPES[next] ?? `\\${next}`;
      continue;
    }
    const hex = value.slice(i + 1, i + 5);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      if (streaming && i + 5 > value.length) {
        return out;
      }
      out += '\\u';
      continue;
    }
    i += 4;
    const code = parseInt(hex, 16);
    if (streaming && code >= 0xd800 && code <= 0xdbff) {
      /** Hold back a high surrogate while its low half could still be
       *  streaming in — the remainder being any proper prefix of `\uXXXX`
       *  (including the empty string). A complete following escape decodes
       *  on the next iteration and composes the pair; anything else means
       *  the lone surrogate is real data (matches `JSON.parse`). */
      const rest = value.slice(i + 1);
      if (/^(?:\\(?:u[0-9a-fA-F]{0,3})?)?$/.test(rest)) {
        return out;
      }
    }
    out += String.fromCharCode(code);
  }
  return out;
}

/** Extracts a string field from tool call args, handling object, JSON string, and partial-JSON fallback. */
export default function parseJsonField(args: ToolCallArgs, field: string): string {
  if (typeof args === 'object' && args !== null) {
    return String(args[field] ?? '');
  }
  try {
    const parsed = JSON.parse(args || '{}');
    if (typeof parsed === 'object' && parsed !== null) {
      return String(parsed[field] ?? '');
    }
  } catch {
    // partial JSON during streaming; fall through to regex
  }
  const match = args?.match(fieldRegex(field));
  if (!match) {
    return '';
  }
  return unescapeJsonString(match[1]);
}

/** Extracts every occurrence of a string field from partially streamed JSON args, in document order. */
export function parseJsonFieldOccurrences(args: ToolCallArgs, field: string): string[] {
  if (typeof args !== 'string' || args.length === 0) {
    return [];
  }
  return Array.from(args.matchAll(fieldRegex(field, 'g')), (match) => unescapeJsonString(match[1]));
}
