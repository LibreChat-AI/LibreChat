import { logger } from '@librechat/data-schemas';
import { AnthropicClientOptions } from '@librechat/agents';
import {
  isOpus55Model,
  OPUS_55_BLOCK_BINDING,
  ThinkingDisplay,
  AnthropicEffort,
  anthropicSettings,
  resolveThinkingDisplay,
  supportsAdaptiveThinking,
  supportsPromptCache,
  requiresExplicitThinkingDisabled,
} from 'librechat-data-provider';

const FINE_GRAINED_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14';

function appendAnthropicBetaHeader(
  headers: Record<string, string> | undefined,
  beta: string,
): Record<string, string> {
  const nextHeaders = { ...(headers ?? {}) };
  const betaValues = (nextHeaders['anthropic-beta'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!betaValues.includes(beta)) {
    betaValues.push(beta);
  }

  nextHeaders['anthropic-beta'] = betaValues.join(',');
  return nextHeaders;
}

/**
 * @param {string} modelName
 * @returns {boolean}
 */
function checkPromptCacheSupport(modelName: string): boolean {
  return supportsPromptCache(modelName);
}

/**
 * Gets the appropriate headers for Claude models with cache control
 * @param {string} model The model name
 * @param {boolean} supportsCacheControl Whether the model supports cache control
 * @returns {AnthropicClientOptions['extendedOptions']['defaultHeaders']|undefined} The headers object or undefined if not applicable
 */
function getClaudeHeaders(
  model: string,
  supportsCacheControl: boolean,
): Record<string, string> | undefined {
  if (!supportsCacheControl) {
    return undefined;
  }

  if (/claude-3[-.]5-sonnet/.test(model)) {
    return {
      'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15',
    };
  } else if (/claude-3[-.]7/.test(model)) {
    return {
      'anthropic-beta': 'token-efficient-tools-2025-02-19,output-128k-2025-02-19',
    };
  }

  return undefined;
}

/**
 * Configures reasoning-related options for Claude models.
 * Models supporting adaptive thinking (Opus 4.6+, Sonnet 4.6+) use effort control instead of manual budget_tokens.
 */
function configureReasoning(
  anthropicInput: AnthropicClientOptions & { max_tokens?: number },
  extendedOptions: {
    thinking?: boolean;
    thinkingBudget?: number | null;
    effort?: AnthropicEffort | string | null;
    thinkingDisplay?: ThinkingDisplay | string | null;
  } = {},
): AnthropicClientOptions & { max_tokens?: number } {
  const updatedOptions = { ...anthropicInput };
  const currentMaxTokens = updatedOptions.max_tokens ?? updatedOptions.maxTokens;
  const modelName = updatedOptions.model ?? '';

  /**
   * Sonnet 5 and Opus 5 run adaptive thinking by default when the `thinking`
   * field is omitted, so honoring a user who turns thinking off requires
   * sending an explicit disabled config rather than leaving the field unset.
   * This returns before effort is applied, which is why the Opus 5 effort cap
   * is enforced by the caller.
   */
  if (!extendedOptions.thinking && modelName && requiresExplicitThinkingDisabled(modelName)) {
    updatedOptions.thinking = { type: 'disabled' } as AnthropicClientOptions['thinking'];
    return updatedOptions;
  }

  if (
    (extendedOptions.thinking || isOpus55Model(modelName)) &&
    modelName &&
    supportsAdaptiveThinking(modelName)
  ) {
    /**
     * For Opus 4.7+, Anthropic omits thinking content from responses by
     * default. Resolver returns `'summarized'` for those models (so the
     * LibreChat "Thoughts" UI keeps working) and leaves the field off for
     * older adaptive models, while honoring an explicit user choice.
     *
     * https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default
     */
    const display = resolveThinkingDisplay(modelName, extendedOptions.thinkingDisplay);
    const adaptive = {
      type: 'adaptive' as const,
      ...(display ? { display } : {}),
      ...(isOpus55Model(modelName) ? { block_binding: { ...OPUS_55_BLOCK_BINDING } } : {}),
    };
    /**
     * TODO: Remove the cast once `@librechat/agents` updates its
     * `ChatAnthropicMessages['thinking']` type to include the `display` field
     * added with Claude Opus 4.7. The cast is required because the installed
     * agents SDK still uses the pre-4.7 `ThinkingConfigAdaptive` shape.
     */
    updatedOptions.thinking = adaptive as AnthropicClientOptions['thinking'];

    const effort = extendedOptions.effort;
    if (effort && effort !== AnthropicEffort.unset) {
      updatedOptions.invocationKwargs = {
        ...updatedOptions.invocationKwargs,
        output_config: { effort },
      };
    }

    if (currentMaxTokens == null) {
      updatedOptions.max_tokens = anthropicSettings.maxOutputTokens.reset(modelName);
    }

    return updatedOptions;
  }

  if (
    extendedOptions.thinking &&
    modelName &&
    (/claude-3[-.]7/.test(modelName) || /claude-(?:sonnet|opus|haiku)-[4-9]/.test(modelName))
  ) {
    updatedOptions.thinking = {
      ...updatedOptions.thinking,
      type: 'enabled',
    } as { type: 'enabled'; budget_tokens: number };
  }

  if (
    updatedOptions.thinking != null &&
    extendedOptions.thinkingBudget != null &&
    updatedOptions.thinking.type === 'enabled'
  ) {
    updatedOptions.thinking = {
      ...updatedOptions.thinking,
      budget_tokens: extendedOptions.thinkingBudget,
    };
  }

  if (
    updatedOptions.thinking != null &&
    updatedOptions.thinking.type === 'enabled' &&
    (currentMaxTokens == null || updatedOptions.thinking.budget_tokens > currentMaxTokens)
  ) {
    const maxTokens = anthropicSettings.maxOutputTokens.reset(modelName);
    updatedOptions.max_tokens = currentMaxTokens ?? maxTokens;

    logger.warn(
      updatedOptions.max_tokens === maxTokens
        ? '[AnthropicClient] max_tokens is not defined while thinking is enabled. Setting max_tokens to model default.'
        : `[AnthropicClient] thinking budget_tokens (${updatedOptions.thinking.budget_tokens}) exceeds max_tokens (${updatedOptions.max_tokens}). Adjusting budget_tokens.`,
    );

    updatedOptions.thinking.budget_tokens = Math.min(
      updatedOptions.thinking.budget_tokens,
      Math.floor((updatedOptions.max_tokens ?? 0) * 0.9),
    );
  }

  return updatedOptions;
}

export {
  FINE_GRAINED_TOOL_STREAMING_BETA,
  appendAnthropicBetaHeader,
  checkPromptCacheSupport,
  getClaudeHeaders,
  configureReasoning,
  supportsAdaptiveThinking,
};
