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
