import { sortNames } from '~/mcp/utils';

/** The part of the app config that holds the agents prompt-cache settings. */
export interface PromptCacheConfig {
  endpoints?: { agents?: { promptCache?: { stableContext?: boolean } } };
}

/** `endpoints.agents.promptCache.stableContext`; off, requests are built as before. */
export function isStableContextEnabled(config?: PromptCacheConfig | null): boolean {
  return config?.endpoints?.agents?.promptCache?.stableContext === true;
}

/** Names in code-unit order with `stableContext`, so the tools array does not depend on selection order; as given otherwise. */
export function orderNames(
  config: PromptCacheConfig | null | undefined,
  names: Iterable<string>,
): string[] {
  return isStableContextEnabled(config) ? sortNames(names) : [...names];
}

/** Providers whose requests carry explicit prompt-cache breakpoints, switched on by `promptCache`. */
const PROMPT_CACHE_PROVIDERS = new Set<string>(['anthropic', 'openrouter', 'bedrock']);

/** Whether the agent's requests use a prompt cache the user can lose by changing the prompt. */
export function hasProviderPromptCache(agent: {
  provider?: string;
  model_parameters?: { promptCache?: unknown } | null;
}): boolean {
  return (
    agent.provider != null &&
    PROMPT_CACHE_PROVIDERS.has(agent.provider) &&
    agent.model_parameters?.promptCache === true
  );
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
