import type { TConversation } from 'librechat-data-provider';

/** A completion can arrive after a manual selection or a newer generation on another replica. */
export function keepNewerAgentRouting<T extends Partial<TConversation>>(
  merged: T,
  local: Partial<TConversation> | null | undefined,
  conversationId: string | null | undefined,
): T {
  if (
    local == null ||
    local.conversationId !== conversationId ||
    merged.conversationId !== conversationId ||
    local.agentRoutingRevision == null ||
    local.agentRoutingRevision <= (merged.agentRoutingRevision ?? 0)
  ) {
    return merged;
  }
  return {
    ...merged,
    agent_id: local.agent_id,
    agentRoutingRevision: local.agentRoutingRevision,
    automaticHandoffsEnabled: local.automaticHandoffsEnabled,
  };
}
