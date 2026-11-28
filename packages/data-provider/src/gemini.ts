export const GEMINI_LONG_DECODE_MAX_OUTPUT_TOKENS = 1_048_576;
export const GEMINI_LONG_DECODE_MAX_CONTEXT_TOKENS = 1_048_576;
export const GEMINI_LONG_DECODE_SEGMENT_OUTPUT_TOKENS = 65_536;

/** Hydrogen's default request budget, not its long-decode output limit. */
export const GEMINI_HYDROGEN_DEFAULT_OUTPUT_TOKENS = 65_536;

/**
 * Output limit for current Gemini text models without long decode. `65535`, not 65536:
 * Vertex rejects 65,536 for these models, so defaulting to it would fail validation.
 */
export const GEMINI_STANDARD_MAX_OUTPUT_TOKENS = 65_535;

/** Match native and provider-prefixed IDs, including versioned Hydrogen aliases. */
export function isGeminiHydrogen(model?: string | null): boolean {
  const id = model?.toLowerCase().split('/').pop() ?? '';
  return id === 'gemini-4-hydrogen' || id.startsWith('gemini-4-hydrogen-');
}

/** Gemini 4 models use the shared-window long-decode protocol. */
export function isGeminiLongDecodeModel(model?: string | null): boolean {
  const id = model?.toLowerCase().split('/').pop() ?? '';
  return id.startsWith('gemini-4-');
}

/** Standard USD per million tokens; output includes thinking. Omit location for Developer API. */
export function getGeminiHydrogenRates(location?: string) {
  if (location && location !== 'global') {
    return { prompt: 1.65, completion: 8.25, read: 0.0825 };
  }
  return { prompt: 1.5, completion: 7.5, read: 0.075 };
}
