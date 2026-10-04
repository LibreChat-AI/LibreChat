import type { AgentSubagentsConfig, GraphEdge } from 'librechat-data-provider';

/** Match the SDK: untyped, unconditional one-to-many edges default to direct. */
export function isHandoffEdge(edge: GraphEdge): boolean {
  const sourceCount = Array.isArray(edge.from) ? edge.from.length : 1;
  const destinationCount = Array.isArray(edge.to) ? edge.to.length : 1;
  const defaultDirect =
    edge.edgeType == null && edge.condition == null && sourceCount === 1 && destinationCount > 1;
  return edge.edgeType !== 'direct' && !defaultDirect;
}

/** Disable orchestration without losing subagent settings or non-handoff edges. */
export function removeOrchestration(subagents?: AgentSubagentsConfig, edges?: GraphEdge[]) {
  return {
    subagents: subagents ? { ...subagents, enabled: false } : undefined,
    edges: (edges ?? []).filter((edge) => !isHandoffEdge(edge)),
  };
}
