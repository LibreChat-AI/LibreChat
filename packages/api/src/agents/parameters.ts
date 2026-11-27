const NUMERIC_PARAM_KEYS = new Set([
  'temperature',
  'top_p',
  'topP',
  'top_k',
  'topK',
  'frequency_penalty',
  'frequencyPenalty',
  'presence_penalty',
  'presencePenalty',
  'max_tokens',
  'maxTokens',
  'max_output_tokens',
  'maxOutputTokens',
  'max_context_tokens',
  'maxContextTokens',
  'fileTokenLimit',
  'thinking_budget',
  'thinkingBudget',
]);

function coerceFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Coerces known numeric model parameter keys to finite numbers, dropping values
 * that cannot be represented as one (e.g. a stray placeholder string captured by
 * the UI). Explicit `0` and negative values are preserved; other keys pass through.
 */
export function sanitizeModelParameters(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!NUMERIC_PARAM_KEYS.has(key)) {
      result[key] = value;
      continue;
    }
    const coerced = coerceFiniteNumber(value);
    if (coerced !== undefined) {
      result[key] = coerced;
    }
  }
  return result;
}
