export interface ReachableAgent<TAgent> {
  readonly subagentAgentConfigs?: readonly (TAgent | null | undefined)[];
  readonly lazySubagentConfigs?: readonly (TAgent | null | undefined)[];
  readonly subagentGraphMemberMetadata?: readonly (TAgent | null | undefined)[];
  readonly subagentGraphConfigs?: readonly {
    readonly memberConfigs?: readonly (TAgent | null | undefined)[];
  }[];
}

/**
 * Collects each agent object reachable from the supplied roots exactly once.
 * Object identity preserves distinct initialized snapshots while preventing
 * shared subagent nodes and cyclic graphs from repeating work.
 */
export function collectReachableAgents<T extends ReachableAgent<T>>(
  roots: readonly (T | null | undefined)[],
): T[] {
  const agents: T[] = [];
  const visited = new Set<T>();
  const pending = [...roots];

  for (let index = 0; index < pending.length; index++) {
    const agent = pending[index];
    if (agent == null || visited.has(agent)) {
      continue;
    }
    visited.add(agent);
    agents.push(agent);
    pending.push(
      ...(agent.subagentAgentConfigs ?? []),
      ...(agent.lazySubagentConfigs ?? []),
      ...(agent.subagentGraphMemberMetadata ?? []),
    );
    for (const graph of agent.subagentGraphConfigs ?? []) {
      pending.push(...(graph.memberConfigs ?? []));
    }
  }

  return agents;
}
