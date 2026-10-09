import { getResponseSender, getEphemeralSender, isEphemeralAgentId } from 'librechat-data-provider';
import type { Agent, TEndpointOption } from 'librechat-data-provider';

/**
 * Resolves the display name persisted as `message.sender` for a response.
 *
 * Real agents use their own name. Ephemeral agents run the same label chain
 * `loadEphemeralAgent` encodes into their id (`modelLabel` → spec label →
 * endpoint `modelDisplayLabel`), recomputed here from the exact source values
 * rather than decoded from the id — the id encoding is lossy for labels
 * containing `__`/`___` sequences, and the persisted sender must match the
 * configured label verbatim. `getResponseSender` remains the fallback for
 * label-less agents (model-derived names such as `Claude` or `GPT-5`, family
 * heuristics, `'AI'`).
 */
export function resolveSender({
  agent,
  specLabel,
  endpointOption,
}: {
  agent: Partial<Pick<Agent, 'id' | 'name'>>;
  specLabel?: string | null;
  endpointOption: Partial<TEndpointOption>;
}): string {
  if (agent.name != null) {
    return agent.name;
  }
  if (agent.id != null && isEphemeralAgentId(agent.id)) {
    const sender = getEphemeralSender({
      modelLabel: endpointOption.modelLabel,
      specLabel,
      modelDisplayLabel: endpointOption.modelDisplayLabel,
    });
    if (sender) {
      return sender;
    }
  }
  return getResponseSender(endpointOption);
}
