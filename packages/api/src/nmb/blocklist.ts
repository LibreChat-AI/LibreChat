import { RE2JS } from 're2js';

export type BlocklistMode = 'literal' | 'regex';
export interface BlocklistChoice {
  value: string;
  mode: BlocklistMode;
}

export const MIN_TERM_LENGTH = 3;
export const MAX_TERM_LENGTH = 200;
export const MAX_ADDITIONS = 50;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type ChoiceError =
  | 'invalid_shape'
  | 'too_many'
  | 'too_short'
  | 'too_long'
  | 'control_chars'
  | 'invalid_regex'
  | 'regex_matches_empty'
  | 'not_in_original';

export type ParsedChoices =
  | { ok: true; literals: string[]; regexes: string[] }
  | { ok: false; error: ChoiceError };

/** Compiles with the linear-time engine the repo uses for operator patterns; rejects anything RE2 cannot run. */
/** A quantified group that itself contains a quantifier, e.g. `(a+)+`: exponential in backtracking engines such as the scanner's. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)[+*{]/;

function validRegex(pattern: string): boolean {
  if (NESTED_QUANTIFIER.test(pattern)) {
    return false;
  }
  let compiled: RE2JS | undefined;
  try {
    compiled = RE2JS.compile(pattern);
    return !compiled.matcher('').find();
  } catch {
    return false;
  } finally {
    compiled?.reset();
  }
}

function matchesRegex(pattern: string, text: string): boolean {
  try {
    return RE2JS.compile(pattern).matcher(text).find();
  } catch {
    return false;
  }
}

/**
 * Validates reviewer-chosen blocklist additions. When `originalTexts` is given every value must
 * occur in the reviewed content, so a reviewer can only add what they actually saw.
 */
export function parseChoices(input: unknown, originalTexts?: string[]): ParsedChoices {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'invalid_shape' };
  }
  if (input.length > MAX_ADDITIONS) {
    return { ok: false, error: 'too_many' };
  }
  const literals = new Set<string>();
  const regexes = new Set<string>();
  const haystack = originalTexts?.join('\n');
  for (const raw of input) {
    const c = raw as Partial<BlocklistChoice> | null;
    if (c == null || typeof c.value !== 'string' || (c.mode !== 'literal' && c.mode !== 'regex')) {
      return { ok: false, error: 'invalid_shape' };
    }
    const value = c.value.trim();
    if (value.length < MIN_TERM_LENGTH) {
      return { ok: false, error: 'too_short' };
    }
    if (value.length > MAX_TERM_LENGTH) {
      return { ok: false, error: 'too_long' };
    }
    if (CONTROL_CHARS.test(value)) {
      return { ok: false, error: 'control_chars' };
    }
    if (c.mode === 'literal') {
      if (haystack != null && !haystack.toLowerCase().includes(value.toLowerCase())) {
        return { ok: false, error: 'not_in_original' };
      }
      literals.add(value);
    } else {
      if (!validRegex(value)) {
        return { ok: false, error: 'invalid_regex' };
      }
      if (haystack != null && !matchesRegex(value, haystack)) {
        return { ok: false, error: 'not_in_original' };
      }
      regexes.add(value);
    }
  }
  return { ok: true, literals: [...literals], regexes: [...regexes] };
}
