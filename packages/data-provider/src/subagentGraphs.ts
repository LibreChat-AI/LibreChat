import { z } from 'zod';
import type { AgentSubagentGraph, AgentSubagentsConfig } from './types/agents';
import { MAX_GRAPH_SUBAGENT_MEMBERS } from './limits';
import { AgentCapabilities } from './config';

const graphSubagentEdgeSchema = z
  .object({
    from: z.union([z.string(), z.array(z.string()).min(1)]),
    to: z.union([z.string(), z.array(z.string()).min(1)]),
    description: z.string().optional(),
    edgeType: z.literal('direct'),
    prompt: z.string().optional(),
    excludeResults: z.boolean().optional(),
  })
  .strict();

function validateGraphSubagentTopology(graph: {
  type: string;
  agent_ids: string[];
  edges: Array<{
    from: string | string[];
    to: string | string[];
    prompt?: string;
    excludeResults?: boolean;
  }>;
  entry_agent_id: string;
  result_agent_id: string;
}): string | undefined {
  const memberIds = new Set(graph.agent_ids);
  if (memberIds.size !== graph.agent_ids.length) {
    return `Graph subagent "${graph.type}" contains duplicate member IDs.`;
  }
  const reservedMemberIds = new Set([
    '__start__',
    '__end__',
    'messages',
    'agentMessages',
    'subagentResult',
  ]);
  const invalidMemberId = graph.agent_ids.find(
    (agentId) => reservedMemberIds.has(agentId) || agentId.includes('|') || agentId.includes(':'),
  );
  if (invalidMemberId) {
    return `Graph subagent "${graph.type}" member "${invalidMemberId}" is reserved by the graph runtime.`;
  }
  if (!memberIds.has(graph.entry_agent_id) || !memberIds.has(graph.result_agent_id)) {
    return `Graph subagent "${graph.type}" entry and result must reference configured members.`;
  }
  const adjacency = new Map(graph.agent_ids.map((agentId) => [agentId, new Set<string>()]));
  const reverse = new Map(graph.agent_ids.map((agentId) => [agentId, new Set<string>()]));
  const incomingGroups = new Map<string, string[][]>();
  const directedEdges = new Set<string>();
  for (const edge of graph.edges) {
    const sources = Array.isArray(edge.from) ? edge.from : [edge.from];
    const destinations = Array.isArray(edge.to) ? edge.to : [edge.to];
    if (
      new Set(sources).size !== sources.length ||
      new Set(destinations).size !== destinations.length
    ) {
      return `Graph subagent "${graph.type}" edge endpoints must be unique.`;
    }
    if (edge.excludeResults === true && !edge.prompt) {
      return `Graph subagent "${graph.type}" cannot exclude results without an edge prompt.`;
    }
    if (edge.prompt && destinations.length !== 1) {
      return `Graph subagent "${graph.type}" prompted edges must have one destination.`;
    }
    for (const agentId of [...sources, ...destinations]) {
      if (!memberIds.has(agentId)) {
        return `Graph subagent "${graph.type}" references unknown member "${agentId}".`;
      }
    }
    for (const destination of destinations) {
      const groups = incomingGroups.get(destination) ?? [];
      groups.push(sources);
      incomingGroups.set(destination, groups);
      for (const source of sources) {
        if (source === destination) {
          return `Graph subagent "${graph.type}" cannot contain self-edges.`;
        }
        const edgeKey = `${source}\0${destination}`;
        if (directedEdges.has(edgeKey)) {
          return `Graph subagent "${graph.type}" contains duplicate edges.`;
        }
        directedEdges.add(edgeKey);
        adjacency.get(source)?.add(destination);
        reverse.get(destination)?.add(source);
      }
    }
  }
  for (const [destination, groups] of Array.from(incomingGroups)) {
    const sources = reverse.get(destination);
    if (sources && sources.size > 1 && (groups.length !== 1 || groups[0].length !== sources.size)) {
      return `Graph subagent "${graph.type}" fan-in to "${destination}" must use one array-valued source edge.`;
    }
  }
  const roots = graph.agent_ids.filter((agentId) => reverse.get(agentId)?.size === 0);
  const sinks = graph.agent_ids.filter((agentId) => adjacency.get(agentId)?.size === 0);
  if (roots.length !== 1 || roots[0] !== graph.entry_agent_id) {
    return `Graph subagent "${graph.type}" must use entry_agent_id as its only root.`;
  }
  if (sinks.length !== 1 || sinks[0] !== graph.result_agent_id) {
    return `Graph subagent "${graph.type}" must use result_agent_id as its only sink.`;
  }
  const remainingIncoming = new Map(
    graph.agent_ids.map((agentId) => [agentId, reverse.get(agentId)?.size ?? 0]),
  );
  const ready = roots.slice();
  let visitedCount = 0;
  while (ready.length > 0) {
    const source = ready.pop();
    if (source === undefined) {
      continue;
    }
    visitedCount++;
    for (const destination of Array.from(adjacency.get(source) ?? [])) {
      const count = (remainingIncoming.get(destination) ?? 0) - 1;
      remainingIncoming.set(destination, count);
      if (count === 0) {
        ready.push(destination);
      }
    }
  }
  if (visitedCount !== memberIds.size) {
    return `Graph subagent "${graph.type}" must be acyclic and fully connected.`;
  }
  const isSimpleChain = graph.agent_ids.every(
    (agentId) => (adjacency.get(agentId)?.size ?? 0) <= 1 && (reverse.get(agentId)?.size ?? 0) <= 1,
  );
  if (
    !isSimpleChain &&
    graph.edges.some(
      (edge) =>
        edge.prompt && (Array.isArray(edge.to) ? edge.to[0] : edge.to) !== graph.result_agent_id,
    )
  ) {
    return `Graph subagent "${graph.type}" prompts in a branched graph must target result_agent_id.`;
  }
  return undefined;
}

export const graphSubagentSchema: z.ZodType<AgentSubagentGraph> = z
  .object({
    type: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    agent_ids: z.array(z.string()).min(1).max(MAX_GRAPH_SUBAGENT_MEMBERS),
    edges: z.array(graphSubagentEdgeSchema),
    entry_agent_id: z.string(),
    result_agent_id: z.string(),
  })
  .superRefine((graph, ctx) => {
    const error = validateGraphSubagentTopology(graph);
    if (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error,
      });
    }
  });

/** Legacy teams retain the ordinary subagents gate until a graph-specific choice is saved. */
export function isSubagentGraphsEnabled(
  config?: Pick<AgentSubagentsConfig, 'enabled' | 'graphsEnabled'> | null,
  capabilities?: readonly string[],
): boolean {
  const capability =
    config?.graphsEnabled == null ? AgentCapabilities.subagents : AgentCapabilities.subagent_graphs;
  return (
    (config?.graphsEnabled ?? config?.enabled === true) &&
    (capabilities == null || capabilities.includes(capability))
  );
}

export function isSubagentsEnabled(
  config?: Pick<AgentSubagentsConfig, 'enabled'> | null,
  capabilities?: readonly string[],
): boolean {
  return (
    config?.enabled === true &&
    (capabilities == null || capabilities.includes(AgentCapabilities.subagents))
  );
}

/** Runtime projection only. Persisted settings and the two user choices remain untouched. */
export function resolveSubagents(
  config?: AgentSubagentsConfig,
  capabilities?: readonly string[],
): AgentSubagentsConfig | undefined {
  if (!config) return undefined;
  const singles = isSubagentsEnabled(config, capabilities);
  const graphs = isSubagentGraphsEnabled(config, capabilities);
  if (config.graphsEnabled == null && singles && graphs) return config;
  return {
    ...config,
    enabled: singles || graphs,
    allowSelf: singles && config.allowSelf !== false,
    agent_ids: singles ? config.agent_ids : [],
    graphsEnabled: graphs,
    graphs: graphs ? config.graphs : [],
  };
}

export function hasSubagentCapability(capabilities: readonly string[]): boolean {
  return (
    capabilities.includes(AgentCapabilities.subagents) ||
    capabilities.includes(AgentCapabilities.subagent_graphs)
  );
}
