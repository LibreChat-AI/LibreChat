export const GEMINI_HYDROGEN_CONTEXT_TOKENS = 1_048_576;
export const GEMINI_HYDROGEN_OUTPUT_TOKENS = 65_536;

/** Match native and provider-prefixed IDs, including versioned Hydrogen aliases. */
export function isGeminiHydrogen(model?: string | null): boolean {
  const id = model?.toLowerCase().split('/').pop() ?? '';
  return id === 'gemini-4-hydrogen' || id.startsWith('gemini-4-hydrogen-');
}

/** Standard USD per million tokens; output includes thinking. Omit location for Developer API. */
export function getGeminiHydrogenRates(location?: string) {
  if (location && location !== 'global') {
    return { prompt: 1.65, completion: 8.25, read: 0.0825 };
  }
  return { prompt: 1.5, completion: 7.5, read: 0.075 };
}
