/** The part of the app config that holds the agents prompt-cache settings. */
export interface PromptCacheConfig {
  endpoints?: { agents?: { promptCache?: { stableContext?: boolean } } };
}

/** `endpoints.agents.promptCache.stableContext`; off, requests are built as before. */
export function isStableContextEnabled(config?: PromptCacheConfig | null): boolean {
  return config?.endpoints?.agents?.promptCache?.stableContext === true;
}

/**
 * The time prompt date variables resolve against: with `stableContext` the
 * conversation start, so the prompt reads the same on every turn; otherwise the
 * turn start.
 */
export function getPromptTime(
  config: PromptCacheConfig | null | undefined,
  times?: { turnStartedAt?: number; conversationCreatedAt?: string } | null,
): string | number | undefined {
  return isStableContextEnabled(config)
    ? (times?.conversationCreatedAt ?? times?.turnStartedAt)
    : times?.turnStartedAt;
}
