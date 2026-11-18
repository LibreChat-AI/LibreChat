import {
  Providers,
  isEphemeralAgentId,
  parseEphemeralAgentId,
  ReasoningParameterFormat,
  hasExplicitReasoningEffort,
} from 'librechat-data-provider';
import type { Agent, TEndpointsConfig } from 'librechat-data-provider';

/**
 * Whether the endpoint's efforts come from a per-model catalog: an OpenRouter parameter set
 * whose administrator did not define `reasoning_effort` themselves. Anything else needs no
 * request and no waiting.
 */
export function usesReasoningCapabilities(
  endpointsConfig: TEndpointsConfig | undefined,
  endpoint: string,
): boolean {
  const customParams = endpointsConfig?.[endpoint]?.customParams;
  return (
    customParams?.defaultParamsEndpoint === Providers.OPENROUTER &&
    customParams.reasoningFormat !== ReasoningParameterFormat.disabled &&
    !hasExplicitReasoningEffort(customParams.paramDefinitions)
  );
}

/**
 * The provider and model an agents-endpoint conversation runs on: the saved agent's, or the
 * target encoded in an ephemeral agent id. A saved agent that has not loaded yet resolves to
 * nothing, so callers fail closed.
 */
export const resolveAgentTarget = (
  agentId: string | null | undefined,
  agent: Pick<Agent, 'provider' | 'model'> | null | undefined,
): { provider: string; model: string } | undefined => {
  if (agent != null) {
    return { provider: agent.provider ?? '', model: agent.model ?? '' };
  }
  if (agentId == null || !isEphemeralAgentId(agentId)) {
    return undefined;
  }
  const parsed = parseEphemeralAgentId(agentId);
  return parsed == null ? undefined : { provider: parsed.endpoint, model: parsed.model };
};
