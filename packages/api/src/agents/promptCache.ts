/** The part of the app config that holds the agents endpoint prompt-cache levers. */
export interface PromptCacheConfig {
  endpoints?: {
    agents?: {
      promptCache?: { stableContext?: boolean };
    };
  };
}

/**
 * Whether `endpoints.agents.promptCache.stableContext` is on. Every behavior
 * that keeps the cacheable prompt prefix stable is gated on it; off, the
 * request is built as it was before the lever existed.
 */
export function isStableContextEnabled(config?: PromptCacheConfig | null): boolean {
  return config?.endpoints?.agents?.promptCache?.stableContext === true;
}
