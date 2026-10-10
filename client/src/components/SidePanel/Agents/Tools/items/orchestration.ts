import type { AgentSubagentsConfig, GraphEdge } from 'librechat-data-provider';

/** Match the SDK: untyped, unconditional one-to-many edges default to direct. */
export function isHandoffEdge(edge: GraphEdge): boolean {
  const sourceCount = Array.isArray(edge.from) ? edge.from.length : 1;
  const destinationCount = Array.isArray(edge.to) ? edge.to.length : 1;
  const defaultDirect =
    edge.edgeType == null && edge.condition == null && sourceCount === 1 && destinationCount > 1;
  return edge.edgeType !== 'direct' && !defaultDirect;
}

/** Persist the explicit flag while retaining the roster, graphs, and granular settings. */
export function setSubagentsEnabled(
  subagents: AgentSubagentsConfig | undefined,
  enabled: boolean,
): AgentSubagentsConfig {
  return {
    ...subagents,
    enabled,
    allowSelf: subagents?.allowSelf ?? true,
    agent_ids: subagents?.agent_ids ?? [],
  };
}

/** Removing handoffs must leave unrelated direct edges intact. */
export function removeHandoffs(edges?: GraphEdge[]): GraphEdge[] {
  return (edges ?? []).filter((edge) => !isHandoffEdge(edge));
}
