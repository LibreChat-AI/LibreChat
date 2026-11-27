import { AgentCapabilities, isSubagentGraphsEnabled } from 'librechat-data-provider';
import type { AgentSubagentsConfig, GraphEdge } from 'librechat-data-provider';

/** Match the SDK: untyped, unconditional one-to-many edges default to direct. */
export function isHandoffEdge(edge: GraphEdge): boolean {
  const sourceCount = Array.isArray(edge.from) ? edge.from.length : 1;
  const destinationCount = Array.isArray(edge.to) ? edge.to.length : 1;
  const defaultDirect =
    edge.edgeType == null && edge.condition == null && sourceCount === 1 && destinationCount > 1;
  return edge.edgeType !== 'direct' && !defaultDirect;
}

/**
 * Persist the explicit flag while retaining the roster, graphs, and granular settings.
 *
 * Teams saved before graph teams had a switch of their own follow `enabled`. Where the deployment
 * offers Subagent Graphs as its own tool, the two are shown as separate choices, so the teams'
 * state as it stands is written down before `enabled` changes: turning ordinary subagents off or
 * on then leaves the teams as they were.
 */
export function setSubagentsEnabled(
  subagents: AgentSubagentsConfig | undefined,
  enabled: boolean,
  capabilities?: readonly string[],
): AgentSubagentsConfig {
  const separate =
    subagents?.graphsEnabled == null &&
    (subagents?.graphs?.length ?? 0) > 0 &&
    capabilities?.includes(AgentCapabilities.subagent_graphs) === true;
  return {
    ...subagents,
    enabled,
    allowSelf: subagents?.allowSelf ?? true,
    agent_ids: subagents?.agent_ids ?? [],
    ...(separate && { graphsEnabled: isSubagentGraphsEnabled(subagents, capabilities) }),
  };
}

/** Removing handoffs must leave unrelated direct edges intact. */
export function removeHandoffs(edges?: GraphEdge[]): GraphEdge[] {
  return (edges ?? []).filter((edge) => !isHandoffEdge(edge));
}
