/**
 * Normalize a human-typed integer for a numeric input field.
 *
 * Strips thousands separators and any stray characters so values like
 * `"120,000"` (US) or `"120.000"` (EU) collapse to `"120000"` instead of being
 * silently truncated to `120` by a downstream `parseInt`. Both `,` and `.` are
 * treated as grouping separators, so this is locale-agnostic.
 *
 * When `allowNegative` is set (for fields whose range permits negatives, e.g.
 * Google `thinkingBudget` where `-1` selects dynamic/auto thinking), a single
 * leading minus is preserved; a lone `"-"` is kept so the sign can be typed
 * before the digits. An empty result is preserved so the field can be cleared,
 * which unsets the value and falls back to the model/server default.
 */
export function sanitizeIntegerInput(value: string, allowNegative = false): string {
  const digits = value.replace(/\D/g, '');
  if (allowNegative && value.trimStart().startsWith('-')) {
    return `-${digits}`;
  }
  return digits;
}
