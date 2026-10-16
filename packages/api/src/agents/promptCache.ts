import { logger } from '@librechat/data-schemas';
import { TOOL_DISPATCHER_NAME } from '@librechat/agents';
import { sortNames } from '~/mcp/utils';

/** The part of the app config that holds the agents endpoint prompt-cache levers. */
export interface PromptCacheConfig {
  endpoints?: {
    agents?: {
      promptCache?: { stableContext?: boolean };
    };
  };
}

let warnedAboutSdk = false;

/**
 * The installed agents SDK has what the lever relies on: the tool dispatcher and
 * `conversation_instructions`, which were released together.
 */
function sdkSupportsStableContext(): boolean {
  if (typeof TOOL_DISPATCHER_NAME === 'string') {
    return true;
  }
  if (!warnedAboutSdk) {
    warnedAboutSdk = true;
    logger.warn(
      '[promptCache] endpoints.agents.promptCache.stableContext is on, but the installed @librechat/agents has no tool dispatcher; the setting is ignored until the SDK is updated',
    );
  }
  return false;
}

/**
 * Whether `endpoints.agents.promptCache.stableContext` is on. Every behavior
 * that keeps the cacheable prompt prefix stable is gated on it; off, the
 * request is built as it was before the lever existed. It stays off, with one
 * warning, while the installed SDK cannot do what the lever needs.
 */
export function isStableContextEnabled(config?: PromptCacheConfig | null): boolean {
  return (
    config?.endpoints?.agents?.promptCache?.stableContext === true && sdkSupportsStableContext()
  );
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

/** Providers whose signed reasoning blocks are stored and sent back with `stableContext`. */
const REASONING_REPLAY_PROVIDERS = new Set<string>(['anthropic', 'bedrock']);

/** Whether a provider's signed reasoning is stored and replayed (needs `stableContext`). */
export function replaysSignedReasoning(
  config: PromptCacheConfig | null | undefined,
  provider?: string | null,
): boolean {
  return (
    provider != null && REASONING_REPLAY_PROVIDERS.has(provider) && isStableContextEnabled(config)
  );
}

/**
 * Identity of the model a history is restored for, as `formatAgentMessages` compares it with the
 * model that signed each stored reasoning block. Undefined when the agent's reasoning is not
 * replayed. `modelName` is the alias some client options use for `model`.
 */
export function getReasoningReplayTarget(
  config: PromptCacheConfig | null | undefined,
  agent: {
    provider?: string | null;
    model?: string | null;
    model_parameters?: { model?: unknown; modelName?: unknown } | null;
  },
): { provider: string; model: string } | undefined {
  if (!replaysSignedReasoning(config, agent.provider)) {
    return undefined;
  }
  const candidates = [
    agent.model_parameters?.model,
    agent.model_parameters?.modelName,
    agent.model,
  ];
  const model = candidates.find(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  return model == null || agent.provider == null ? undefined : { provider: agent.provider, model };
}
