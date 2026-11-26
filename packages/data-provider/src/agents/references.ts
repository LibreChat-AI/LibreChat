import type { AgentSubagentGraph, AgentSubagentsConfig } from '../types/agents';

function hasGraphReference(graph: AgentSubagentGraph, removed: ReadonlySet<string>): boolean {
  const includes = (endpoint: string | string[]): boolean =>
    Array.isArray(endpoint) ? endpoint.some((id) => removed.has(id)) : removed.has(endpoint);
  return (
    graph.agent_ids.some((id) => removed.has(id)) ||
    removed.has(graph.entry_agent_id) ||
    removed.has(graph.result_agent_id) ||
    graph.edges.some((edge) => includes(edge.from) || includes(edge.to))
  );
}

export function hasSubagentReference(
  subagents: AgentSubagentsConfig | undefined,
  removed: ReadonlySet<string>,
): boolean {
  return (
    subagents?.agent_ids?.some((id) => removed.has(id)) === true ||
    subagents?.graphs?.some((graph) => hasGraphReference(graph, removed)) === true
  );
}

/** Remove whole affected teams: pruning individual members can invalidate their topology. */
export function pruneSubagentReferences(
  subagents: AgentSubagentsConfig,
  removed: ReadonlySet<string>,
): AgentSubagentsConfig {
  if (!hasSubagentReference(subagents, removed)) {
    return subagents;
  }
  return {
    ...subagents,
    ...(subagents.agent_ids != null && {
      agent_ids: subagents.agent_ids.filter((id) => !removed.has(id)),
    }),
    ...(subagents.graphs != null && {
      graphs: subagents.graphs.filter((graph) => !hasGraphReference(graph, removed)),
    }),
  };
}
