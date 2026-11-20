import type { PromptCacheConfig } from './promptCache';
import { isStableContextEnabled } from './promptCache';

/**
 * Whether Anthropic signed reasoning is stored and replayed (needs `stableContext`). Bedrock is
 * left out: without the turn context segments (#17146) a stale block after a prompt change would
 * cost a rejected request on every later turn.
 */
export function replaysSignedReasoning(
  config: PromptCacheConfig | null | undefined,
  provider?: string | null,
): boolean {
  return provider === 'anthropic' && isStableContextEnabled(config);
}

/**
 * Whether a run's Anthropic client speaks the Anthropic Messages API: not a custom client such as
 * Vertex AI, which may reject the beta header the SDK binds replayed blocks with. A custom base URL
 * (a reverse proxy) counts, since `stableContext` is an explicit opt-in; the proxy has to forward
 * the `anthropic-beta` header.
 */
export function callsAnthropicMessagesApi(llmConfig: object | null | undefined): boolean {
  return (llmConfig as { createClient?: unknown } | null)?.createClient == null;
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
